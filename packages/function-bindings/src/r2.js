/**
 * Yoal R2 binding service (docs/FUNCTIONS.md §4.5, FN10).
 *
 * A Worker that implements the workerd R2 binding protocol on top of a managed RustFS instance
 * spoken to over the S3 API. The user Worker gets an `r2Bucket` binding pointing at this service;
 * workerd turns every `R2Bucket` method into one HTTP request to `POST /` with the operation and its
 * arguments in the `cf-r2-request` header (or, for bodies, prefixed to the request body under
 * `cf-r2-metadata-size`). The reply is the R2 object metadata JSON followed by the value bytes.
 *
 * Protocol shape adapted from Miniflare (Apache-2.0), cloudflare/workers-sdk:
 * packages/miniflare/src/workers/r2/{bucket,r2Object,schemas,errors,constants}.worker.ts.
 *
 * Scope: single-part objects. Multipart uploads (`createMultipartUpload`, `uploadPart`,
 * `completeMultipartUpload`, `abortMultipartUpload`) answer with an explicit 501 R2 error instead
 * of half-uploading to RustFS. `put()` buffers the body so it can compute the MD5 ETag locally and
 * sign a real payload hash; the buffer is capped at 25 MiB (Cloudflare allows far more, but a
 * binding worker has to hold the bytes to hash them without a streaming digest).
 *
 * Every S3 request is SigV4-signed with WebCrypto and targeted strictly at the configured
 * `<PREFIX>_ENDPOINT_URL`: object keys are appended to that endpoint, never resolved as URLs.
 * The secret access key is never logged, echoed in an error or included in a response.
 *
 * Plain JavaScript ESM: workerd loads this file as text and embeds it as a module. No imports, no
 * Node APIs, no eval, only Web APIs.
 */

/** Operation and arguments for header-carrying requests (get/head/list/delete). */
const REQUEST_HEADER = 'cf-r2-request';
/** Byte length of the JSON metadata that prefixes a PUT body, and of the reply metadata. */
const METADATA_SIZE_HEADER = 'cf-r2-metadata-size';
/** JSON `{ message, version, v4code }` workerd turns into the thrown R2 error. */
const ERROR_HEADER = 'cf-r2-error';

/** Cloudflare's R2 custom-metadata limit is 8 KiB; keys and values are counted raw. */
const MAX_CUSTOM_METADATA_BYTES = 8 * 1024;
/** Miniflare's object-name limit (`R2Limits.MAX_KEY_SIZE`). */
const MAX_KEY_BYTES = 1024;
/** `R2Limits.MAX_LIST_KEYS`. */
const MAX_LIST_KEYS = 1000;
/** R2 may return fewer results when metadata is requested; Miniflare caps `include` at 100. */
const MAX_INCLUDE_KEYS = 100;
/** S3 `DeleteObjects` accepts at most 1000 keys per request. */
const MAX_DELETE_KEYS = 1000;
/** Our own put cap: buffered so MD5 can be computed and the payload signed (see header). */
const MAX_OBJECT_BYTES = 25 * 1024 * 1024;
/** The JSON prefix of a PUT is bounded: 8 KiB of custom metadata plus the operation fields. */
const MAX_REQUEST_METADATA_BYTES = 32 * 1024;
/** RustFS accepts any region; SDKs insist on one (docs/OBJECT-STORAGE.md). */
const DEFAULT_REGION = 'us-east-1';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
/** RFC 7230 token: what an S3 `x-amz-meta-*` header name can carry. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** R2 v4 error codes (Miniflare's errors.worker.ts; workerd maps the throw from `v4code`). */
const R2_ERROR_CODES = {
	internal: 10001,
	noSuchKey: 10007,
	entityTooLarge: 100100,
	metadataTooLarge: 10012,
	invalidObjectName: 10020,
	invalidMaxKeys: 10022,
	invalidArgument: 10029,
	preconditionFailed: 10031,
	invalidRange: 10039,
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** An error that maps to the HTTP + `cf-r2-error` reply workerd expects. */
class R2Error extends Error {
	constructor(status, message, v4code) {
		super(message);
		this.status = status;
		this.v4code = v4code;
		/** Optional object metadata workerd attaches to a failed get()/put(). */
		this.object = null;
	}

	/** Attach the current object metadata, as Miniflare's `PreconditionFailed` does for get. */
	withObject(object) {
		this.object = object;
		return this;
	}
}

export default {
	async fetch(request, env) {
		try {
			return await handleRequest(request, env);
		} catch (error) {
			return errorResponse(error);
		}
	},
};

// ---------------------------------------------------------------- request dispatch

async function handleRequest(request, env) {
	const config = readConfig(env);
	const method = request.method.toUpperCase();

	// workerd's r2-rpc client uses GET for head/get/list and PUT for put/delete/multipart; newer
	// builds may use DELETE for deletes, so accept the same metadata on either method.
	if (method === 'GET' || method === 'HEAD') {
		const metadata = decodeHeaderMetadata(request);
		switch (metadata.method) {
			case 'head':
				return encodeMetadata(await headObject(config, requireObject(metadata)));
			case 'get':
				return getObject(config, metadata);
			case 'list':
				return encodeList(await listObjects(config, metadata));
			default:
				throw internalError();
		}
	}

	if (method === 'PUT') {
		const { metadata, value } = await decodeBodyMetadata(request);
		switch (metadata.method) {
			case 'put':
				return encodeMetadata(await putObject(config, metadata, value));
			case 'delete':
				await deleteObjects(config, 'object' in metadata ? metadata.object : metadata.objects);
				return new Response(null, { status: 200 });
			case 'createMultipartUpload':
			case 'uploadPart':
			case 'completeMultipartUpload':
			case 'abortMultipartUpload':
				throw new R2Error(
					501,
					'Multipart uploads are not supported by this R2 binding: Yoal stores objects single-part (25 MiB per put).',
					R2_ERROR_CODES.invalidArgument,
				);
			default:
				throw internalError();
		}
	}

	if (method === 'DELETE') {
		const metadata = decodeHeaderMetadata(request);
		if (metadata.method !== 'delete') throw internalError();
		await deleteObjects(config, 'object' in metadata ? metadata.object : metadata.objects);
		return new Response(null, { status: 200 });
	}

	throw new R2Error(405, `Method ${method} is not part of the R2 binding protocol.`, R2_ERROR_CODES.invalidArgument);
}

function readConfig(env) {
	const endpointNames = Object.keys(env).filter(
		(name) => name.endsWith('_ENDPOINT_URL') && typeof env[name] === 'string' && env[name] !== '',
	);
	if (endpointNames.length !== 1)
		throw new R2Error(
			500,
			`R2 binding is misconfigured: expected exactly one <PREFIX>_ENDPOINT_URL binding, found ${endpointNames.length}.`,
			R2_ERROR_CODES.internal,
		);
	const endpointName = endpointNames[0];
	const prefix = endpointName.slice(0, -'_ENDPOINT_URL'.length);

	let endpoint;
	try {
		endpoint = new URL(env[endpointName]);
	} catch {
		throw new R2Error(500, `R2 binding is misconfigured: ${endpointName} is not a URL.`, R2_ERROR_CODES.internal);
	}
	if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:')
		throw new R2Error(
			500,
			`R2 binding is misconfigured: ${endpointName} must be an http(s) URL.`,
			R2_ERROR_CODES.internal,
		);
	// The endpoint is the only authority this binding talks to: strip anything that could redirect
	// the path beyond the base and the appended bucket/key.
	endpoint.search = '';
	endpoint.hash = '';
	const base = endpoint.toString().replace(/\/+$/, '');

	const bucket = env.BUCKET_NAME;
	if (typeof bucket !== 'string' || bucket === '')
		throw new R2Error(500, 'R2 binding is misconfigured: BUCKET_NAME is missing.', R2_ERROR_CODES.internal);
	const accessKeyId = env[`${prefix}_ACCESS_KEY_ID`];
	const secretAccessKey = env[`${prefix}_SECRET_ACCESS_KEY`];
	if (typeof accessKeyId !== 'string' || accessKeyId === '' || typeof secretAccessKey !== 'string' || secretAccessKey === '')
		throw new R2Error(
			500,
			`R2 binding is misconfigured: ${prefix}_ACCESS_KEY_ID or ${prefix}_SECRET_ACCESS_KEY is missing.`,
			R2_ERROR_CODES.internal,
		);

	return {
		endpoint: base,
		bucket,
		accessKeyId,
		secretAccessKey,
		region: (env[`${prefix}_REGION`] || '').trim() || DEFAULT_REGION,
		// Path-style is the only addressing RustFS exposes (docs/OBJECT-STORAGE.md); the injected
		// FORCE_PATH_STYLE value is accepted for parity with the shared S3 env and otherwise unused.
		keyPrefix: typeof env.KEY_PREFIX === 'string' ? env.KEY_PREFIX : '',
		fetchImpl: typeof env.FETCH === 'function' ? env.FETCH : fetch,
		now: () => Date.now(),
	};
}

/** The full S3 key for a client-visible key: the attachment prefix is applied here, once. */
function storageKey(config, key) {
	return config.keyPrefix + key;
}

/** Strip the attachment prefix from a key or common prefix S3 returned. */
function clientKey(config, key) {
	return key.startsWith(config.keyPrefix) ? key.slice(config.keyPrefix.length) : key;
}

// ---------------------------------------------------------------- request metadata

function decodeHeaderMetadata(request) {
	const header = request.headers.get(REQUEST_HEADER);
	if (header === null) throw invalidMetadata();
	return parseRequestMetadata(header);
}

async function decodeBodyMetadata(request) {
	const rawSize = request.headers.get(METADATA_SIZE_HEADER);
	const metadataSize = rawSize === null ? Number.NaN : Number.parseInt(rawSize, 10);
	if (!Number.isInteger(metadataSize) || metadataSize < 0 || metadataSize > MAX_REQUEST_METADATA_BYTES)
		throw invalidMetadata();

	// Reject an oversized upload before buffering it when the size is declared. The body also
	// holds the metadata prefix, so the cap is relative to `metadataSize`.
	const contentLength = Number.parseInt(request.headers.get('content-length') ?? '', 10);
	if (Number.isFinite(contentLength) && contentLength > metadataSize + MAX_OBJECT_BYTES) throw entityTooLarge();

	const body = request.body === null ? new Uint8Array(0) : new Uint8Array(await request.arrayBuffer());
	if (body.byteLength > metadataSize + MAX_OBJECT_BYTES) throw entityTooLarge();
	if (body.byteLength < metadataSize) throw invalidMetadata();

	const metadata = parseRequestMetadata(textDecoder.decode(body.subarray(0, metadataSize)));
	return { metadata, value: body.subarray(metadataSize) };
}

function parseRequestMetadata(json) {
	let metadata;
	try {
		metadata = JSON.parse(json);
	} catch {
		throw invalidMetadata();
	}
	if (!metadata || typeof metadata !== 'object' || typeof metadata.method !== 'string') throw invalidMetadata();
	return metadata;
}

function requireObject(metadata) {
	if (typeof metadata.object !== 'string') throw invalidMetadata();
	return metadata.object;
}

// ---------------------------------------------------------------- object operations

async function headObject(config, key) {
	validateKey(key);
	const response = await s3Request(config, { method: 'HEAD', key: storageKey(config, key) });
	if (response.status === 404) throw noSuchKey();
	if (!response.ok) throw await backendError(response);
	const object = metadataFromHeaders(response.headers, key, null);
	// Miniflare's `#head` reports the whole object as the range it "served".
	return withRange(object, 0, object.size);
}

async function getObject(config, metadata) {
	const key = requireObject(metadata);
	validateKey(key);

	// `onlyIf` is the R2 conditional (workerd sends it as JSON, not as HTTP If-* headers). Miniflare
	// checks the key exists first, then the condition; a failed condition still carries the object
	// metadata so workerd can set `R2Error.object`.
	if (metadata.onlyIf) {
		const head = await s3Request(config, { method: 'HEAD', key: storageKey(config, key) });
		if (head.status === 404) throw noSuchKey();
		if (!head.ok) throw await backendError(head);
		const current = metadataFromHeaders(head.headers, key, null);
		if (!testConditional(metadata.onlyIf, current))
			throw preconditionFailed().withObject(withRange(current, 0, current.size));
	}

	const rangeHeader = rangeHeaderFor(metadata);
	const headers = rangeHeader === undefined ? {} : { range: rangeHeader };

	let response = await s3Request(config, { method: 'GET', key: storageKey(config, key), headers });
	if (response.status === 404) throw noSuchKey();
	if (response.status === 416) {
		if (metadata.range) throw invalidRange();
		// Miniflare's range parser ignores an unsatisfiable `rangeHeader` and returns the whole
		// object; S3 answers 416, so retry without the header to keep that behaviour.
		response = await s3Request(config, { method: 'GET', key: storageKey(config, key) });
	}
	if (!response.ok) throw await backendError(response);

	const range = parseContentRange(response.headers.get('content-range'));
	const object = metadataFromHeaders(response.headers, key, range);
	// Miniflare's `#get` always returns a body object with the range it served (the whole object by
	// default), while `size` stays the full object size.
	if (object.range === undefined) object.range = { offset: 0, length: object.size };
	// A chunked S3 reply declares neither a content-length nor a content-range: then the body length
	// is unknown, so the reply must be chunked too rather than carry a wrong content-length.
	const lengthKnown = range !== null || response.headers.get('content-length') !== null;
	return encodeObjectBody(object, response.body, lengthKnown ? object.range.length : Number.NaN);
}

async function putObject(config, metadata, value) {
	const key = requireObject(metadata);
	validateKey(key);
	// workerd sends custom metadata as `[{ k, v }]` (Miniflare's RecordSchema); accept a plain record
	// too so hand-written requests stay usable.
	const customMetadata = customFieldsOf(metadata.customFields);
	validateCustomMetadata(customMetadata);

	if (value.byteLength > MAX_OBJECT_BYTES) throw entityTooLarge();

	// Preconditions apply to the *previous* object; a missing key fails etagMatches/uploadedAfter.
	if (metadata.onlyIf) {
		const previous = await readConditionMetadata(config, storageKey(config, key));
		if (!testConditional(metadata.onlyIf, previous)) throw preconditionFailed();
	}

	const md5 = md5Bytes(value);
	const headers = {};
	if (metadata.httpFields) {
		const http = metadata.httpFields;
		if (http.contentType) headers['content-type'] = http.contentType;
		if (http.contentLanguage) headers['content-language'] = http.contentLanguage;
		if (http.contentDisposition) headers['content-disposition'] = http.contentDisposition;
		if (http.contentEncoding) headers['content-encoding'] = http.contentEncoding;
		if (http.cacheControl) headers['cache-control'] = http.cacheControl;
		if (typeof http.cacheExpiry === 'number' && Number.isFinite(http.cacheExpiry))
			headers.expires = new Date(http.cacheExpiry).toUTCString();
	}
	try {
		for (const [name, metadataValue] of Object.entries(customMetadata))
			headers[`x-amz-meta-${name.toLowerCase()}`] = metadataValue;
		headers['content-md5'] = base64FromBytes(md5);
	} catch {
		throw new R2Error(400, 'Custom metadata values must be header-safe.', R2_ERROR_CODES.metadataTooLarge);
	}

	const response = await s3Request(config, {
		method: 'PUT',
		key: storageKey(config, key),
		headers,
		body: value,
	});
	if (!response.ok) throw await backendError(response);

	const etag = stripQuotes(response.headers.get('etag') ?? '') || toHex(md5);
	return {
		key,
		version: response.headers.get('x-amz-version-id') || etag,
		size: value.byteLength,
		etag,
		uploaded: config.now(),
		httpMetadata: metadata.httpFields ?? {},
		customMetadata,
		range: undefined,
	};
}

async function deleteObjects(config, keys) {
	const list = Array.isArray(keys) ? keys : [keys];
	if (list.length === 0) return;
	for (const key of list) validateKey(key);

	// A single key is one DELETE: S3 accepts deleting a missing key, matching R2's delete.
	if (list.length === 1) {
		const response = await s3Request(config, { method: 'DELETE', key: storageKey(config, list[0]) });
		if (!response.ok && response.status !== 404) throw await backendError(response);
		return;
	}

	for (let index = 0; index < list.length; index += MAX_DELETE_KEYS) {
		const batch = list.slice(index, index + MAX_DELETE_KEYS);
		const objects = batch
			.map((key) => `<Object><Key>${escapeXml(storageKey(config, key))}</Key></Object>`)
			.join('');
		const body = textEncoder.encode(`<Delete><Quiet>true</Quiet>${objects}</Delete>`);
		const response = await s3Request(config, {
			method: 'POST',
			query: { delete: '' },
			headers: { 'content-type': 'application/xml', 'content-md5': base64FromBytes(md5Bytes(body)) },
			body,
		});
		if (!response.ok) throw await backendError(response);
		// Quiet mode reports only failures; any <Error> means some keys were not deleted.
		const xml = await response.text();
		const failures = xmlBlocks(xml, 'Error').length;
		if (failures > 0)
			throw new R2Error(
				500,
				`The storage backend could not delete ${failures} of ${batch.length} objects.`,
				R2_ERROR_CODES.internal,
			);
	}
}

async function listObjects(config, options) {
	const limit = options.limit === undefined ? MAX_LIST_KEYS : Number(options.limit);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_KEYS) throw invalidMaxKeys();

	const include = (Array.isArray(options.include) ? options.include : []).map((value) =>
		// workerd sends the numeric `R2ListOptions.include` slots (0 = httpMetadata, 1 = customMetadata).
		value === 0 ? 'httpMetadata' : value === 1 ? 'customMetadata' : value,
	);
	const includeHttp = include.includes('httpMetadata');
	const includeCustom = include.includes('customMetadata');
	// R2 returns fewer rows when metadata is requested (Miniflare caps at 100) because each row
	// then needs its own metadata lookup.
	const effectiveLimit = include.length > 0 ? Math.min(limit, MAX_INCLUDE_KEYS) : limit;

	const prefix = typeof options.prefix === 'string' ? options.prefix : '';
	const query = { 'list-type': 2, 'max-keys': effectiveLimit };
	if (config.keyPrefix + prefix !== '') query.prefix = config.keyPrefix + prefix;
	const delimiter = options.delimiter === '' ? undefined : options.delimiter;
	if (typeof delimiter === 'string') query.delimiter = delimiter;
	if (typeof options.cursor === 'string') query['continuation-token'] = decodeCursor(options.cursor);
	else if (typeof options.startAfter === 'string') query['start-after'] = config.keyPrefix + options.startAfter;

	const response = await s3Request(config, { method: 'GET', query });
	if (!response.ok) throw await backendError(response);
	const xml = await response.text();

	const objects = xmlBlocks(xml, 'Contents').map((block) => {
		const key = clientKey(config, xmlTag(block, 'Key') ?? '');
		const etag = stripQuotes(xmlTag(block, 'ETag') ?? '');
		const uploaded = parseHttpDate(xmlTag(block, 'LastModified') ?? '');
		return {
			key,
			version: etag,
			size: Number.parseInt(xmlTag(block, 'Size') ?? '0', 10) || 0,
			etag,
			uploaded: Number.isFinite(uploaded) ? uploaded : 0,
			httpMetadata: {},
			customMetadata: {},
			range: undefined,
		};
	});
	const delimitedPrefixes = xmlBlocks(xml, 'CommonPrefixes')
		.map((block) => xmlTag(block, 'Prefix') ?? '')
		.filter((value) => value !== '')
		.map((value) => clientKey(config, value));

	if (objects.length > 0 && (includeHttp || includeCustom)) {
		const enriched = await Promise.all(
			objects.map(async (object) => {
				const head = await s3Request(config, { method: 'HEAD', key: storageKey(config, object.key) });
				if (!head.ok) return object;
				return metadataFromHeaders(head.headers, object.key, null);
			}),
		);
		for (const [index, object] of enriched.entries()) {
			if (!includeHttp) object.httpMetadata = {};
			if (!includeCustom) object.customMetadata = {};
			objects[index] = object;
		}
	}

	const truncated = (xmlTag(xml, 'IsTruncated') ?? '').toLowerCase() === 'true';
	const token = truncated ? xmlTag(xml, 'NextContinuationToken') : null;
	return {
		objects,
		truncated: token !== null && token !== '',
		...(token !== null && token !== '' ? { cursor: encodeCursor(token) } : {}),
		delimitedPrefixes,
	};
}

/** HEAD for a conditional check; a missing key yields `undefined` (Miniflare's "no metadata"). */
async function readConditionMetadata(config, key) {
	const response = await s3Request(config, { method: 'HEAD', key });
	if (response.status === 404) return undefined;
	if (!response.ok) throw await backendError(response);
	return metadataFromHeaders(response.headers, key, null);
}

// ---------------------------------------------------------------- R2 conditionals (RFC 7232)

/**
 * Port of Miniflare's `_testR2Conditional` (validator.worker.ts), including its ETag strength
 * rules and the `secondsGranularity` truncation.
 */
function testConditional(condition, metadata) {
	if (metadata === undefined) {
		const ifMatch = condition.etagMatches === undefined;
		const ifModifiedSince = condition.uploadedAfter === undefined;
		return ifMatch && ifModifiedSince;
	}

	const ifMatch = condition.etagMatches === undefined || includesEtag(condition.etagMatches, metadata.etag, 'strong');
	const ifNoneMatch =
		condition.etagDoesNotMatch === undefined || !includesEtag(condition.etagDoesNotMatch, metadata.etag, 'weak');
	const truncate = condition.secondsGranularity
		? (milliseconds) => Math.floor(milliseconds / 1000) * 1000
		: (milliseconds) => milliseconds;
	const lastModified = truncate(metadata.uploaded);
	const ifModifiedSince =
		condition.uploadedAfter === undefined ||
		truncate(toMillis(condition.uploadedAfter)) < lastModified ||
		(condition.etagDoesNotMatch !== undefined && ifNoneMatch);
	const ifUnmodifiedSince =
		condition.uploadedBefore === undefined ||
		lastModified < truncate(toMillis(condition.uploadedBefore)) ||
		(condition.etagMatches !== undefined && ifMatch);
	return ifMatch && ifNoneMatch && ifModifiedSince && ifUnmodifiedSince;
}

function includesEtag(conditions, etag, comparison) {
	for (const condition of conditions) {
		if (!condition || typeof condition !== 'object') continue;
		if (condition.type === 'wildcard') return true;
		if (condition.value === etag && (condition.type === 'strong' || comparison === 'weak')) return true;
	}
	return false;
}

/** workerd sends conditional dates as epoch milliseconds; tolerate an ISO string too. */
function toMillis(value) {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

/** R2's typed range option and Miniflare's "one range or the whole object" rangeHeader rule. */
function rangeHeaderFor(metadata) {
	// Miniflare's validator checks `rangeHeader` first, then the typed `range`.
	if (typeof metadata.rangeHeader === 'string') {
		// Multi-range and non-byte ranges are ignored (Miniflare's parseRanges usage): R2 serves the
		// whole object rather than a multipart/byteranges body.
		const match = /^bytes=(\d*)-(\d*)$/.exec(metadata.rangeHeader.trim());
		if (!match) return undefined;
		const [, rawStart, rawEnd] = match;
		if (rawStart === '' && rawEnd === '') return undefined;
		return metadata.rangeHeader.trim();
	}
	if (!metadata.range || typeof metadata.range !== 'object') return undefined;
	const { offset, length, suffix } = metadata.range;
	if (suffix !== undefined) {
		const value = Number(suffix);
		if (!Number.isFinite(value) || value <= 0) throw invalidRange();
		return `bytes=-${Math.trunc(value)}`;
	}
	const start = offset === undefined ? 0 : Number(offset);
	if (!Number.isSafeInteger(start) || start < 0) throw invalidRange();
	if (length !== undefined) {
		const size = Number(length);
		if (!Number.isSafeInteger(size) || size <= 0) throw invalidRange();
		return `bytes=${start}-${start + size - 1}`;
	}
	return `bytes=${start}-`;
}

// ---------------------------------------------------------------- object metadata

function metadataFromHeaders(headers, key, range) {
	const etag = stripQuotes(headers.get('etag') ?? '');
	const size = range !== null ? range.total : numberOrZero(headers.get('content-length'));
	const uploaded = parseHttpDate(headers.get('last-modified') ?? '');
	const object = {
		key,
		version: headers.get('x-amz-version-id') || etag,
		size,
		etag,
		uploaded: Number.isFinite(uploaded) ? uploaded : 0,
		httpMetadata: httpMetadataFromHeaders(headers),
		customMetadata: customMetadataFromHeaders(headers),
		range: range !== null ? { offset: range.start, length: range.end - range.start + 1 } : undefined,
	};
	return object;
}

function httpMetadataFromHeaders(headers) {
	const http = {};
	const contentType = headers.get('content-type');
	if (contentType !== null) http.contentType = contentType;
	const contentLanguage = headers.get('content-language');
	if (contentLanguage !== null) http.contentLanguage = contentLanguage;
	const contentDisposition = headers.get('content-disposition');
	if (contentDisposition !== null) http.contentDisposition = contentDisposition;
	const contentEncoding = headers.get('content-encoding');
	if (contentEncoding !== null) http.contentEncoding = contentEncoding;
	const cacheControl = headers.get('cache-control');
	if (cacheControl !== null) http.cacheControl = cacheControl;
	const expires = headers.get('expires');
	if (expires !== null) {
		const parsed = Date.parse(expires);
		if (Number.isFinite(parsed)) http.cacheExpiry = parsed;
	}
	return http;
}

function customMetadataFromHeaders(headers) {
	const custom = {};
	for (const [name, value] of headers.entries()) {
		if (!name.toLowerCase().startsWith('x-amz-meta-')) continue;
		custom[name.slice('x-amz-meta-'.length)] = value;
	}
	return custom;
}

function withRange(object, offset, length) {
	return { ...object, range: { offset, length } };
}

/**
 * `r2Object.worker.ts`'s `#rawProperties()` field-for-field: `name`, `version`, `size`, `etag`,
 * `uploaded` (epoch ms), `httpFields`, `customFields: [{ k, v }]`, `range`, `checksums: {0: md5}`.
 */
function rawProperties(object) {
	const properties = {
		name: object.key,
		version: object.version,
		size: object.size,
		etag: object.etag,
		uploaded: object.uploaded,
		httpFields: object.httpMetadata ?? {},
		customFields: Object.entries(object.customMetadata ?? {}).map(([k, v]) => ({ k, v })),
	};
	if (object.range !== undefined) properties.range = object.range;
	// Miniflare fills checksums.md5 from the ETag for single-part objects and serialises the
	// numeric R2Checksums slots; undefined slots are dropped by JSON.stringify, like Miniflare.
	const checksums = {};
	if (/^[0-9a-f]{32}$/i.test(object.etag)) checksums[0] = object.etag.toLowerCase();
	properties.checksums = checksums;
	return properties;
}

// ---------------------------------------------------------------- responses

function encodeMetadata(object, status = 200) {
	const json = JSON.stringify(rawProperties(object));
	const size = byteLength(json);
	return new Response(json, {
		status,
		headers: {
			[METADATA_SIZE_HEADER]: String(size),
			'content-type': 'application/json',
			'content-length': String(size),
		},
	});
}

/**
 * Metadata JSON followed by the value bytes, with `cf-r2-metadata-size` telling workerd where the
 * split is. `content-length` is the whole body (metadata + value) when the value length is known.
 */
function encodeObjectBody(object, value, valueLength) {
	const json = JSON.stringify(rawProperties(object));
	const metadata = textEncoder.encode(json);
	const reader = value === null ? null : value.getReader();
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(metadata);
			if (reader === null) controller.close();
		},
		// Pull-driven, so the consumer's backpressure reaches S3 instead of buffering the object.
		async pull(controller) {
			if (reader === null) return;
			const { done, value: chunk } = await reader.read();
			if (done) {
				controller.close();
				return;
			}
			controller.enqueue(chunk);
		},
		async cancel(reason) {
			await reader?.cancel(reason);
		},
	});
	const headers = {
		[METADATA_SIZE_HEADER]: String(metadata.byteLength),
		'content-type': 'application/json',
	};
	if (Number.isFinite(valueLength) && valueLength >= 0)
		headers['content-length'] = String(metadata.byteLength + valueLength);
	return new Response(body, { status: 200, headers });
}

function encodeList(result) {
	// Miniflare's `InternalR2Object.encodeMultiple`: the same per-object encoding, then the list
	// envelope (`objects`, `truncated`, `cursor`, `delimitedPrefixes`).
	const json = JSON.stringify({ ...result, objects: result.objects.map((object) => rawProperties(object)) });
	const size = byteLength(json);
	return new Response(json, {
		headers: {
			[METADATA_SIZE_HEADER]: String(size),
			'content-type': 'application/json',
			'content-length': String(size),
		},
	});
}

function errorResponse(error) {
	if (error instanceof R2Error && error.object !== null) {
		const response = encodeMetadata(error.object, error.status);
		response.headers.set(ERROR_HEADER, errorPayload(error));
		return response;
	}
	const status = error instanceof R2Error ? error.status : 500;
	const message = error instanceof R2Error ? error.message : 'We encountered an internal error. Please try again.';
	const v4code = error instanceof R2Error ? error.v4code : R2_ERROR_CODES.internal;
	return new Response(null, {
		status,
		headers: { [ERROR_HEADER]: JSON.stringify({ message, version: 1, v4code }) },
	});
}

function errorPayload(error) {
	return JSON.stringify({ message: error.message, version: 1, v4code: error.v4code });
}

function invalidMetadata() {
	return new R2Error(400, 'Metadata missing or invalid', R2_ERROR_CODES.invalidArgument);
}

function internalError() {
	return new R2Error(
		500,
		'We encountered an internal error. Please try again.',
		R2_ERROR_CODES.internal,
	);
}

function noSuchKey() {
	return new R2Error(404, 'The specified key does not exist.', R2_ERROR_CODES.noSuchKey);
}

function invalidObjectName() {
	return new R2Error(400, 'The specified object name is not valid.', R2_ERROR_CODES.invalidObjectName);
}

function entityTooLarge() {
	return new R2Error(
		413,
		'Your proposed upload exceeds the maximum allowed object size.',
		R2_ERROR_CODES.entityTooLarge,
	);
}

function metadataTooLarge() {
	return new R2Error(
		400,
		'Your metadata headers exceed the maximum allowed metadata size.',
		R2_ERROR_CODES.metadataTooLarge,
	);
}

function invalidMaxKeys() {
	return new R2Error(400, 'MaxKeys params must be positive integer <= 1000.', R2_ERROR_CODES.invalidMaxKeys);
}

function preconditionFailed() {
	return new R2Error(
		412,
		'At least one of the pre-conditions you specified did not hold.',
		R2_ERROR_CODES.preconditionFailed,
	);
}

function invalidRange() {
	return new R2Error(416, 'The requested range is not satisfiable', R2_ERROR_CODES.invalidRange);
}

/** Never echo the S3 message: a 403 from some servers quotes the access key id. */
async function backendError(response) {
	const text = await response.text().catch(() => '');
	const code = xmlTag(text, 'Code') ?? `HTTP${response.status}`;
	return new R2Error(
		500,
		`The storage backend rejected the request (${code}, HTTP ${response.status}).`,
		R2_ERROR_CODES.internal,
	);
}

// ---------------------------------------------------------------- validation

function validateKey(key) {
	if (byteLength(key) > MAX_KEY_BYTES) throw invalidObjectName();
	// WHATWG URL parsing collapses "." and ".." segments (even percent-encoded), so an S3 path could
	// silently address a different key. Refuse instead of writing somewhere the caller did not name.
	if (key.split('/').some((segment) => segment === '.' || segment === '..')) throw invalidObjectName();
}

function validateCustomMetadata(customMetadata) {
	if (!customMetadata || typeof customMetadata !== 'object') return;
	let bytes = 0;
	for (const [name, value] of Object.entries(customMetadata)) {
		bytes += byteLength(name) + byteLength(String(value));
		if (!HEADER_NAME_PATTERN.test(name))
			throw new R2Error(400, 'Custom metadata keys must be header-safe ASCII names.', R2_ERROR_CODES.metadataTooLarge);
		if (/[\r\n]/.test(String(value)))
			throw new R2Error(400, 'Custom metadata values cannot contain newlines.', R2_ERROR_CODES.metadataTooLarge);
	}
	if (bytes > MAX_CUSTOM_METADATA_BYTES) throw metadataTooLarge();
}

/** Decode the wire `customFields` (`[{ k, v }]`) into the record S3 headers need. */
function customFieldsOf(raw) {
	const fields = {};
	if (Array.isArray(raw)) {
		for (const entry of raw) {
			if (!entry || typeof entry.k !== 'string') continue;
			fields[entry.k] = entry.v === undefined || entry.v === null ? '' : String(entry.v);
		}
	} else if (raw && typeof raw === 'object') {
		for (const [name, value] of Object.entries(raw)) fields[name] = String(value);
	}
	return fields;
}

// ---------------------------------------------------------------- S3 / SigV4

async function s3Request(config, options) {
	const path = objectPath(config, options.key);
	const url = new URL(config.endpoint + path);
	const pairs = Object.entries(options.query ?? {})
		.filter(([, value]) => value !== undefined && value !== null)
		.map(([name, value]) => [awsEncode(name), awsEncode(String(value))])
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	if (pairs.length > 0) url.search = pairs.map(([name, value]) => `${name}=${value}`).join('&');

	const body = options.body;
	const payloadHash = body === undefined ? EMPTY_SHA256 : await sha256Hex(body);
	const amzDate = formatAmzDate(new Date(config.now()));
	const headers = new Headers();
	for (const [name, value] of Object.entries(options.headers ?? {})) {
		if (value === undefined || value === null) continue;
		headers.set(name, String(value));
	}
	headers.set('x-amz-date', amzDate);
	headers.set('x-amz-content-sha256', payloadHash);
	// Keep the value bytes exactly the object bytes: a transparently-decompressed body would make
	// the declared content-length and the R2 range metadata disagree with what workerd receives.
	headers.set('accept-encoding', 'identity');
	headers.set(
		'authorization',
		await sigv4Authorization({ method: options.method, url, headers, payloadHash, config, amzDate }),
	);

	const init = { method: options.method, headers };
	if (body !== undefined) init.body = body;
	return config.fetchImpl(url.toString(), init);
}

/** Path-style URL path: `/<bucket>` or `/<bucket>/<encoded key>`. */
function objectPath(config, key) {
	const bucket = encodePathSegment(config.bucket);
	if (key === undefined) return `/${bucket}`;
	return `/${bucket}/${encodeKeyPath(key)}`;
}

function encodeKeyPath(key) {
	return key
		.split('/')
		.map((segment) => encodePathSegment(segment))
		.join('/');
}

function encodePathSegment(segment) {
	return awsEncode(segment);
}

function awsEncode(value) {
	return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function sigv4Authorization({ method, url, headers, payloadHash, config, amzDate }) {
	const dateStamp = amzDate.slice(0, 8);
	// `host` is signed but not set on the outgoing Headers: fetch derives it from the URL, and some
	// runtimes refuse an explicit Host header. The value is the same either way.
	const entries = [...headers.entries()].filter(([name]) => name !== 'authorization');
	entries.push(['host', url.host]);
	entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const signedHeaderNames = entries.map(([name]) => name);
	const canonicalHeaders = entries
		.map(([name, value]) => `${name}:${normalizeHeaderValue(value)}\n`)
		.join('');
	const canonicalRequest = [
		method,
		url.pathname,
		url.search === '' ? '' : url.search.slice(1),
		canonicalHeaders,
		signedHeaderNames.join(';'),
		payloadHash,
	].join('\n');
	const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		amzDate,
		scope,
		await sha256Hex(textEncoder.encode(canonicalRequest)),
	].join('\n');
	const signingKey = await signingKeyFor(config.secretAccessKey, dateStamp, config.region);
	const signature = toHex(await hmac(signingKey, stringToSign));
	return `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;
}

/** AWS canonicalises header values by trimming and folding runs of spaces. */
function normalizeHeaderValue(value) {
	return String(value).trim().replace(/\s+/g, ' ');
}

async function signingKeyFor(secretAccessKey, dateStamp, region) {
	const dateKey = await hmac(textEncoder.encode(`AWS4${secretAccessKey}`), dateStamp);
	const regionKey = await hmac(dateKey, region);
	const serviceKey = await hmac(regionKey, 's3');
	return hmac(serviceKey, 'aws4_request');
}

async function hmac(key, data) {
	const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const bytes = typeof data === 'string' ? textEncoder.encode(data) : data;
	return new Uint8Array(await crypto.subtle.sign('HMAC', imported, bytes));
}

async function sha256Hex(data) {
	return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

function formatAmzDate(date) {
	const iso = date.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
	return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

function toHex(bytes) {
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
}

function base64FromBytes(bytes) {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

// ---------------------------------------------------------------- MD5 (no WebCrypto MD5)

/** Standard table, derived rather than hardcoded: `floor(abs(sin(i + 1)) * 2^32)`. */
const MD5_SHIFTS = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
	20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
	15, 21,
];
const MD5_CONSTANTS = new Int32Array(64).map((_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) | 0);

/**
 * MD5 of a byte array, as 16 bytes. WebCrypto deliberately has no MD5, but S3's single-part ETag is
 * the MD5 of the body, so the binding computes it in JavaScript (RFC 1321).
 */
function md5Bytes(input) {
	const paddedLength = (((input.length + 8) >> 6) << 6) + 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(input);
	padded[input.length] = 0x80;
	const view = new DataView(padded.buffer);
	const bitLength = input.length * 8;
	view.setUint32(paddedLength - 8, bitLength >>> 0, true);
	view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

	let a0 = 0x67452301;
	let b0 = 0xefcdab89 | 0;
	let c0 = 0x98badcfe | 0;
	let d0 = 0x10325476 | 0;
	const words = new Int32Array(16);

	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let i = 0; i < 16; i++) words[i] = view.getInt32(offset + i * 4, true);
		let a = a0;
		let b = b0;
		let c = c0;
		let d = d0;
		for (let i = 0; i < 64; i++) {
			let f;
			let g;
			if (i < 16) {
				f = (b & c) | (~b & d);
				g = i;
			} else if (i < 32) {
				f = (d & b) | (~d & c);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				f = b ^ c ^ d;
				g = (3 * i + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * i) % 16;
			}
			f = (f + a + MD5_CONSTANTS[i] + words[g]) | 0;
			a = d;
			d = c;
			c = b;
			const shift = MD5_SHIFTS[i];
			b = (b + ((f << shift) | (f >>> (32 - shift)))) | 0;
		}
		a0 = (a0 + a) | 0;
		b0 = (b0 + b) | 0;
		c0 = (c0 + c) | 0;
		d0 = (d0 + d) | 0;
	}

	const digest = new Uint8Array(16);
	const out = new DataView(digest.buffer);
	out.setInt32(0, a0, true);
	out.setInt32(4, b0, true);
	out.setInt32(8, c0, true);
	out.setInt32(12, d0, true);
	return digest;
}

// ---------------------------------------------------------------- small helpers

/** Base64 cursor wrapping S3's opaque continuation token; R2's cursor is opaque to callers. */
function encodeCursor(token) {
	return btoa(token);
}

function decodeCursor(cursor) {
	try {
		return atob(cursor);
	} catch {
		throw new R2Error(400, 'The list cursor is not valid.', R2_ERROR_CODES.invalidArgument);
	}
}

function xmlTag(xml, tag) {
	const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
	return match ? unescapeXml(match[1]) : null;
}

function xmlBlocks(xml, tag) {
	const blocks = [];
	const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
	for (let match = pattern.exec(xml); match !== null; match = pattern.exec(xml)) blocks.push(match[1]);
	return blocks;
}

function escapeXml(value) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function unescapeXml(value) {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/&amp;/g, '&');
}

function stripQuotes(etag) {
	return etag.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
}

function parseHttpDate(value) {
	if (!value) return Number.NaN;
	return Date.parse(value);
}

/** `bytes <start>-<end>/<total>` from a 206 reply, or null for a full 200. */
function parseContentRange(header) {
	if (!header) return null;
	const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header.trim());
	if (!match) return null;
	const start = Number(match[1]);
	const end = Number(match[2]);
	const total = match[3] === '*' ? end + 1 : Number(match[3]);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null;
	return { start, end, total: Number.isSafeInteger(total) ? total : end + 1 };
}

function numberOrZero(value) {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function byteLength(value) {
	return textEncoder.encode(value).byteLength;
}

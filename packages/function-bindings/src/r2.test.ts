import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import r2Worker from './r2.js';

/**
 * Tests for the Skiff R2 binding service. Everything runs against an in-process fake of the RustFS
 * S3 endpoint: no network, no real credentials (the values below are AWS's published documentation
 * example key pair), and a fixed clock so SigV4 signatures are deterministic.
 */

const ENDPOINT = 'http://127.0.0.1:9000';
const BUCKET = 'uploads';
const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const KEY_PREFIX = 'tenant/';
const BASE = 'https://r2.internal/';
const FIXED_NOW = Date.parse('2026-11-06T12:00:00Z');
const ORIGINAL_NOW = Date.now;
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const MIB = 1024 * 1024;

interface StoredObject {
	body: Buffer;
	contentType: string;
	metadata: Record<string, string>;
	uploaded: Date;
}

interface RecordedRequest {
	method: string;
	url: URL;
	headers: Headers;
	body?: Buffer;
}

function md5Hex(value: Buffer): string {
	return createHash('md5').update(value).digest('hex');
}

function escapeXml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A minimal path-style S3 server: HEAD/GET/PUT/DELETE, ListObjectsV2 and DeleteObjects. */
class FakeS3 {
	objects = new Map<string, StoredObject>();
	requests: RecordedRequest[] = [];
	/** Simulate a backend that does not return an ETag, forcing the worker to use its local MD5. */
	omitPutEtag = false;
	/** When set, every S3 request answers with this failure. */
	failure: { status: number; body: string } | null = null;

	seed(
		key: string,
		value: string,
		options: { contentType?: string; metadata?: Record<string, string>; uploaded?: Date } = {},
	) {
		this.objects.set(key, {
			body: Buffer.from(value),
			contentType: options.contentType ?? 'text/plain',
			metadata: options.metadata ?? {},
			uploaded: options.uploaded ?? new Date('2026-11-06T10:00:00Z'),
		});
	}

	fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
		const method = (init.method ?? 'GET').toUpperCase();
		const headers = new Headers(init.headers as HeadersInit);
		const body = init.body === undefined || init.body === null ? undefined : Buffer.from(init.body as Uint8Array);
		this.requests.push({ method, url, headers, body });

		if (this.failure) {
			return new Response(this.failure.body, {
				status: this.failure.status,
				headers: { 'content-type': 'application/xml' },
			});
		}

		const bucketPath = `/${BUCKET}`;
		if (url.pathname === bucketPath || url.pathname === `${bucketPath}/`) {
			if (method === 'GET' && url.searchParams.get('list-type') === '2') return this.list(url.searchParams);
			if (method === 'POST' && url.searchParams.has('delete')) return this.deleteObjects(body);
			return new Response('unsupported bucket operation', { status: 400 });
		}
		if (!url.pathname.startsWith(`${bucketPath}/`)) return new Response('no such bucket', { status: 404 });
		const key = decodeURIComponent(url.pathname.slice(bucketPath.length + 1));
		const object = this.objects.get(key);

		if (method === 'HEAD') {
			if (!object) return new Response(null, { status: 404 });
			return new Response(null, { headers: this.objectHeaders(object, object.body.length) });
		}
		if (method === 'PUT') {
			const custom: Record<string, string> = {};
			for (const [name, value] of headers.entries())
				if (name.startsWith('x-amz-meta-')) custom[name.slice('x-amz-meta-'.length)] = value;
			this.objects.set(key, {
				body: body ?? Buffer.alloc(0),
				contentType: headers.get('content-type') ?? 'application/octet-stream',
				metadata: custom,
				uploaded: new Date(FIXED_NOW),
			});
			const responseHeaders = new Headers();
			if (!this.omitPutEtag) responseHeaders.set('etag', `"${md5Hex(body ?? Buffer.alloc(0))}"`);
			return new Response(null, { status: 200, headers: responseHeaders });
		}
		if (method === 'DELETE') {
			this.objects.delete(key);
			return new Response(null, { status: 204 });
		}
		if (method === 'GET') {
			if (!object) return new Response(null, { status: 404 });
			const range = headers.get('range');
			if (range === null) {
				return new Response(object.body, {
					status: 200,
					headers: this.objectHeaders(object, object.body.length),
				});
			}
			const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
			if (!match) return new Response(null, { status: 416 });
			const total = object.body.length;
			const [, rawStart, rawEnd] = match;
			let start: number;
			let end: number;
			if (rawStart === '') {
				const suffix = Number(rawEnd);
				start = Math.max(0, total - suffix);
				end = total - 1;
			} else {
				start = Number(rawStart);
				end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1);
			}
			if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || start > end) {
				return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
			}
			const headersOut = this.objectHeaders(object, end - start + 1);
			headersOut.set('content-range', `bytes ${start}-${end}/${total}`);
			return new Response(object.body.subarray(start, end + 1), { status: 206, headers: headersOut });
		}
		return new Response('unsupported', { status: 405 });
	};

	private objectHeaders(object: StoredObject, contentLength: number): Headers {
		const headers = new Headers();
		headers.set('etag', `"${md5Hex(object.body)}"`);
		headers.set('last-modified', object.uploaded.toUTCString());
		headers.set('content-type', object.contentType);
		headers.set('content-length', String(contentLength));
		for (const [name, value] of Object.entries(object.metadata)) headers.set(`x-amz-meta-${name}`, value);
		return headers;
	}

	private list(params: URLSearchParams): Response {
		const prefix = params.get('prefix') ?? '';
		const delimiter = params.get('delimiter') ?? '';
		const maxKeys = Number(params.get('max-keys') ?? '1000');
		const token = params.get('continuation-token');
		const after = token === null ? (params.get('start-after') ?? '') : atob(token);

		const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix) && key > after).sort();
		// A page is a mix of objects and (with a delimiter) grouped prefixes, like S3's KeyCount.
		const entries: Array<{ kind: 'key'; key: string } | { kind: 'prefix'; prefix: string }> = [];
		const seen = new Set<string>();
		for (const key of keys) {
			const rest = key.slice(prefix.length);
			const at = delimiter === '' ? -1 : rest.indexOf(delimiter);
			if (at >= 0) {
				const common = prefix + rest.slice(0, at + delimiter.length);
				if (seen.has(common)) continue;
				seen.add(common);
				entries.push({ kind: 'prefix', prefix: common });
			} else {
				entries.push({ kind: 'key', key });
			}
		}
		const page = entries.slice(0, maxKeys);
		const truncated = entries.length > page.length;
		const last = page[page.length - 1];
		const nextToken = truncated && last ? btoa(last.kind === 'key' ? last.key : last.prefix) : null;

		const contents = page
			.filter((entry): entry is { kind: 'key'; key: string } => entry.kind === 'key')
			.map((entry) => {
				const object = this.objects.get(entry.key)!;
				return [
					'<Contents>',
					`<Key>${escapeXml(entry.key)}</Key>`,
					`<LastModified>${object.uploaded.toISOString()}</LastModified>`,
					`<ETag>&quot;${md5Hex(object.body)}&quot;</ETag>`,
					`<Size>${object.body.length}</Size>`,
					'</Contents>',
				].join('');
			})
			.join('');
		const prefixes = page
			.filter((entry): entry is { kind: 'prefix'; prefix: string } => entry.kind === 'prefix')
			.map((entry) => `<CommonPrefixes><Prefix>${escapeXml(entry.prefix)}</Prefix></CommonPrefixes>`)
			.join('');

		const xml = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<ListBucketResult>',
			`<Name>${BUCKET}</Name>`,
			`<Prefix>${escapeXml(prefix)}</Prefix>`,
			`<KeyCount>${page.length}</KeyCount>`,
			`<MaxKeys>${maxKeys}</MaxKeys>`,
			`<IsTruncated>${truncated}</IsTruncated>`,
			nextToken === null ? '' : `<NextContinuationToken>${nextToken}</NextContinuationToken>`,
			contents,
			prefixes,
			'</ListBucketResult>',
		].join('');
		return new Response(xml, { headers: { 'content-type': 'application/xml' } });
	}

	private deleteObjects(body: Buffer | undefined): Response {
		const xml = body?.toString('utf8') ?? '';
		for (const match of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
			const key = match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
			this.objects.delete(key);
		}
		return new Response('<DeleteResult></DeleteResult>', { headers: { 'content-type': 'application/xml' } });
	}
}

function makeEnv(s3: FakeS3, overrides: Record<string, unknown> = {}) {
	return {
		S3_ENDPOINT_URL: ENDPOINT,
		S3_ACCESS_KEY_ID: ACCESS_KEY,
		S3_SECRET_ACCESS_KEY: SECRET_KEY,
		S3_REGION: 'us-east-1',
		S3_FORCE_PATH_STYLE: 'true',
		BUCKET_NAME: BUCKET,
		KEY_PREFIX,
		FETCH: s3.fetch,
		...overrides,
	};
}

function headerRequest(metadata: Record<string, unknown>): Request {
	return new Request(BASE, { headers: { 'cf-r2-request': JSON.stringify(metadata) } });
}

function bodyRequest(metadata: Record<string, unknown>, value: Uint8Array | Buffer): Request {
	// The R2 protocol prefixes the JSON metadata to the body and reports its byte length.
	const metadataJson = new TextEncoder().encode(JSON.stringify(metadata));
	const body = new Uint8Array(metadataJson.byteLength + value.byteLength);
	body.set(metadataJson, 0);
	body.set(value, metadataJson.byteLength);
	return new Request(BASE, {
		method: 'PUT',
		headers: {
			'cf-r2-metadata-size': String(metadataJson.byteLength),
			'content-length': String(body.byteLength),
		},
		body,
	});
}

interface DecodedResponse {
	status: number;
	headers: Headers;
	metadata: Record<string, any> | undefined;
	value: Buffer;
}

async function decode(response: Response): Promise<DecodedResponse> {
	const bytes = Buffer.from(await response.arrayBuffer());
	const size = Number.parseInt(response.headers.get('cf-r2-metadata-size') ?? '0', 10);
	return {
		status: response.status,
		headers: response.headers,
		metadata: size > 0 ? JSON.parse(bytes.subarray(0, size).toString('utf8')) : undefined,
		value: bytes.subarray(size),
	};
}

function errorBody(response: Response): { message: string; version: number; v4code: number } {
	const header = response.headers.get('cf-r2-error');
	expect(header).not.toBeNull();
	return JSON.parse(header!);
}

function text(value: string): Buffer {
	return Buffer.from(value, 'utf8');
}

/**
 * Recompute the SigV4 signature from the recorded request with node:crypto. This is deliberately a
 * second implementation: it proves the worker's canonical request, key derivation and hex encoding.
 */
function verifySignature(request: RecordedRequest): { signedHeaders: string[]; region: string } {
	const authorization = request.headers.get('authorization') ?? '';
	const match = /^AWS4-HMAC-SHA256 Credential=([^/,]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
		authorization,
	);
	expect(match).not.toBeNull();
	const [, credential, dateStamp, region, signedHeaders, signature] = match!;
	const names = signedHeaders.split(';');
	expect(names).toContain('host');
	expect(names).toContain('x-amz-content-sha256');
	expect(names).toContain('x-amz-date');

	const canonicalHeaders = names
		.map((name) => {
			const raw = name === 'host' ? request.url.host : (request.headers.get(name) ?? '');
			return `${name}:${raw.trim().replace(/\s+/g, ' ')}\n`;
		})
		.join('');
	const payloadHash = request.body
		? createHash('sha256').update(request.body).digest('hex')
		: EMPTY_SHA256;
	expect(request.headers.get('x-amz-content-sha256')).toBe(payloadHash);

	const canonicalRequest = [
		request.method,
		request.url.pathname,
		request.url.search.slice(1),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join('\n');
	const amzDate = request.headers.get('x-amz-date')!;
	expect(amzDate).toBe('20261106T120000Z');
	const scope = `${dateStamp}/${region}/s3/aws4_request`;
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		amzDate,
		scope,
		createHash('sha256').update(canonicalRequest).digest('hex'),
	].join('\n');

	let key: Buffer = createHmac('sha256', `AWS4${SECRET_KEY}`).update(dateStamp).digest();
	key = createHmac('sha256', key).update(region).digest();
	key = createHmac('sha256', key).update('s3').digest();
	key = createHmac('sha256', key).update('aws4_request').digest();
	expect(signature).toBe(createHmac('sha256', key).update(stringToSign).digest('hex'));
	expect(credential).toBe(ACCESS_KEY);
	return { signedHeaders: names, region };
}

beforeEach(() => {
	Date.now = () => FIXED_NOW;
});

afterEach(() => {
	Date.now = ORIGINAL_NOW;
});

describe('R2 put', () => {
	test('frames metadata and value, signs a path-style PUT and returns R2 metadata', async () => {
		const s3 = new FakeS3();
		const env = makeEnv(s3);

		const response = await r2Worker.fetch(
			bodyRequest(
				{
					method: 'put',
					object: 'hello.txt',
					customFields: [{ k: 'owner', v: 'ada' }],
					httpFields: { contentType: 'text/plain', cacheControl: 'max-age=60' },
				},
				text('hello'),
			),
			env,
		);
		const decoded = await decode(response);

		expect(decoded.status).toBe(200);
		expect(decoded.value.byteLength).toBe(0);
		expect(decoded.metadata).toEqual({
			name: 'hello.txt',
			version: '5d41402abc4b2a76b9719d911017c592',
			size: 5,
			etag: '5d41402abc4b2a76b9719d911017c592',
			uploaded: FIXED_NOW,
			httpFields: { contentType: 'text/plain', cacheControl: 'max-age=60' },
			customFields: [{ k: 'owner', v: 'ada' }],
			checksums: { 0: '5d41402abc4b2a76b9719d911017c592' },
		});
		// The metadata-only reply declares its own length, like Miniflare's head/put encoding.
		expect(decoded.headers.get('content-length')).toBe(String(Buffer.byteLength(JSON.stringify(decoded.metadata))));
		expect(decoded.headers.get('content-type')).toBe('application/json');

		expect(s3.requests).toHaveLength(1);
		const request = s3.requests[0]!;
		expect(request.method).toBe('PUT');
		expect(request.url.origin).toBe(ENDPOINT);
		expect(request.url.pathname).toBe(`/${BUCKET}/${KEY_PREFIX}hello.txt`);
		expect(request.headers.get('content-type')).toBe('text/plain');
		expect(request.headers.get('cache-control')).toBe('max-age=60');
		expect(request.headers.get('x-amz-meta-owner')).toBe('ada');
		expect(request.headers.get('content-md5')).toBe(createHash('md5').update('hello').digest('base64'));
		expect(request.body?.toString('utf8')).toBe('hello');
		verifySignature(request);
	});

	test('falls back to a locally computed MD5 ETag when S3 returns none', async () => {
		const s3 = new FakeS3();
		s3.omitPutEtag = true;
		const env = makeEnv(s3);
		const long = 'x'.repeat(200); // crosses the 64-byte MD5 block boundary

		const decoded = await decode(
			await r2Worker.fetch(bodyRequest({ method: 'put', object: 'long.bin' }, text(long)), env),
		);
		expect(decoded.metadata?.etag).toBe(createHash('md5').update(long).digest('hex'));
		expect(decoded.metadata?.checksums).toEqual({ 0: createHash('md5').update(long).digest('hex') });
	});

	test('rejects a value larger than the 25 MiB cap before calling S3', async () => {
		const s3 = new FakeS3();
		const env = makeEnv(s3);
		const request = new Request(BASE, {
			method: 'PUT',
			headers: {
				'cf-r2-metadata-size': '2',
				'content-length': String(25 * MIB + 64),
			},
			body: '{}',
		});
		const response = await r2Worker.fetch(request, env);
		expect(response.status).toBe(413);
		expect(errorBody(response)).toMatchObject({ v4code: 100100 });
		expect(s3.requests).toHaveLength(0);
	});

	test('maps the multipart operations to an explicit 501 R2 error', async () => {
		const s3 = new FakeS3();
		const env = makeEnv(s3);
		for (const method of [
			'createMultipartUpload',
			'uploadPart',
			'completeMultipartUpload',
			'abortMultipartUpload',
		]) {
			const response = await r2Worker.fetch(
				bodyRequest({ method, object: 'big.bin', uploadId: 'u', partNumber: 1, parts: [] }, text('')),
				env,
			);
			expect(response.status).toBe(501);
			expect(errorBody(response).message).toContain('Multipart uploads are not supported');
		}
		expect(s3.requests).toHaveLength(0);
	});
});

describe('R2 get and head', () => {
	test('splits the response at cf-r2-metadata-size and returns the whole value', async () => {
		const s3 = new FakeS3();
		s3.seed(`${KEY_PREFIX}hello.txt`, 'hello world', { contentType: 'text/plain' });
		const env = makeEnv(s3);

		const decoded = await decode(await r2Worker.fetch(headerRequest({ method: 'get', object: 'hello.txt' }), env));
		expect(decoded.status).toBe(200);
		expect(decoded.value.toString('utf8')).toBe('hello world');
		expect(decoded.metadata).toMatchObject({
			name: 'hello.txt',
			size: 11,
			etag: md5Hex(Buffer.from('hello world')),
			range: { offset: 0, length: 11 },
			httpFields: { contentType: 'text/plain' },
			checksums: { 0: md5Hex(Buffer.from('hello world')) },
		});
		expect(decoded.headers.get('content-length')).toBe(
			String(Number(decoded.headers.get('cf-r2-metadata-size')) + 11),
		);
		// A full read is a 200, never S3's 206 shape.
		expect(decoded.headers.get('content-type')).toBe('application/json');
		verifySignature(s3.requests[0]!);
	});

	test('head returns metadata only, with the full range and no value', async () => {
		const s3 = new FakeS3();
		s3.seed(`${KEY_PREFIX}hello.txt`, 'hello world');
		const env = makeEnv(s3);

		const decoded = await decode(await r2Worker.fetch(headerRequest({ method: 'head', object: 'hello.txt' }), env));
		expect(decoded.status).toBe(200);
		expect(decoded.value.byteLength).toBe(0);
		expect(decoded.metadata).toMatchObject({ name: 'hello.txt', size: 11, range: { offset: 0, length: 11 } });
		expect(decoded.headers.get('content-length')).toBe(decoded.headers.get('cf-r2-metadata-size'));
	});

	test('get with a typed range forwards one Range header and reports the served range', async () => {
		const s3 = new FakeS3();
		s3.seed(`${KEY_PREFIX}hello.txt`, 'hello world');
		const env = makeEnv(s3);

		const decoded = await decode(
			await r2Worker.fetch(
				headerRequest({ method: 'get', object: 'hello.txt', range: { offset: 0, length: 5 } }),
				env,
			),
		);
		expect(decoded.status).toBe(200);
		expect(decoded.value.toString('utf8')).toBe('hello');
		expect(decoded.metadata).toMatchObject({ size: 11, range: { offset: 0, length: 5 } });
		expect(s3.requests[0]!.headers.get('range')).toBe('bytes=0-4');
	});

	test('get with a suffix range header returns the tail and its offset', async () => {
		const s3 = new FakeS3();
		s3.seed(`${KEY_PREFIX}hello.txt`, 'hello world');
		const env = makeEnv(s3);

		const decoded = await decode(
			await r2Worker.fetch(
				headerRequest({ method: 'get', object: 'hello.txt', rangeHeader: 'bytes=-5' }),
				env,
			),
		);
		expect(decoded.value.toString('utf8')).toBe('world');
		expect(decoded.metadata).toMatchObject({ size: 11, range: { offset: 6, length: 5 } });
	});

	test('an unsatisfiable range header falls back to the whole object, like Miniflare', async () => {
		const s3 = new FakeS3();
		s3.seed(`${KEY_PREFIX}hello.txt`, 'hello world');
		const env = makeEnv(s3);

		const decoded = await decode(
			await r2Worker.fetch(
				headerRequest({ method: 'get', object: 'hello.txt', rangeHeader: 'bytes=50-60' }),
				env,
			),
		);
		expect(decoded.status).toBe(200);
		expect(decoded.value.toString('utf8')).toBe('hello world');
		expect(decoded.metadata?.range).toEqual({ offset: 0, length: 11 });
		// One 416 from S3, then the unbounded retry.
		expect(s3.requests.map((request) => request.headers.get('range'))).toEqual(['bytes=50-60', null]);
	});

	test('maps a missing key to R2 NoSuchKey', async () => {
		const s3 = new FakeS3();
		const env = makeEnv(s3);

		const response = await r2Worker.fetch(headerRequest({ method: 'get', object: 'missing.txt' }), env);
		expect(response.status).toBe(404);
		expect(errorBody(response)).toEqual({
			message: 'The specified key does not exist.',
			version: 1,
			v4code: 10007,
		});
		expect(await response.text()).toBe('');
	});

	test('a failed onlyIf matches Miniflare and attaches the object metadata', async () => {
		const s3 = new FakeS3();
		s3.seed(`${KEY_PREFIX}hello.txt`, 'hello world');
		const env = makeEnv(s3);

		const response = await r2Worker.fetch(
			headerRequest({
				method: 'get',
				object: 'hello.txt',
				onlyIf: { etagMatches: [{ type: 'strong', value: 'ffffffffffffffffffffffffffffffff' }] },
			}),
			env,
		);
		expect(response.status).toBe(412);
		expect(errorBody(response)).toMatchObject({ v4code: 10031 });
		const decoded = await decode(response);
		expect(decoded.metadata).toMatchObject({ name: 'hello.txt', size: 11, range: { offset: 0, length: 11 } });
		// Only the HEAD was issued: the condition never reached S3 as a GET.
		expect(s3.requests.map((request) => request.method)).toEqual(['HEAD']);
	});

	test('a satisfied onlyIf serves the value', async () => {
		const s3 = new FakeS3();
		s3.seed(`${KEY_PREFIX}hello.txt`, 'hello world');
		const env = makeEnv(s3);
		const etag = md5Hex(Buffer.from('hello world'));

		const decoded = await decode(
			await r2Worker.fetch(
				headerRequest({
					method: 'get',
					object: 'hello.txt',
					onlyIf: {
						etagMatches: [{ type: 'strong', value: etag }],
						uploadedAfter: FIXED_NOW - 86_400_000,
						secondsGranularity: true,
					},
				}),
				env,
			),
		);
		expect(decoded.status).toBe(200);
		expect(decoded.value.toString('utf8')).toBe('hello world');
	});
});

describe('R2 put preconditions', () => {
	test('etagDoesNotMatch "*" fails on an existing object without a PUT', async () => {
		const s3 = new FakeS3();
		s3.seed(`${KEY_PREFIX}hello.txt`, 'old');
		const env = makeEnv(s3);

		const response = await r2Worker.fetch(
			bodyRequest(
				{ method: 'put', object: 'hello.txt', onlyIf: { etagDoesNotMatch: [{ type: 'wildcard' }] } },
				text('new'),
			),
			env,
		);
		expect(response.status).toBe(412);
		expect(errorBody(response)).toMatchObject({ v4code: 10031 });
		expect(s3.requests.map((request) => request.method)).toEqual(['HEAD']);
	});

	test('etagMatches "*" fails when the key does not exist, and passes when it does', async () => {
		const s3 = new FakeS3();
		const env = makeEnv(s3);
		const missing = await r2Worker.fetch(
			bodyRequest(
				{ method: 'put', object: 'new.txt', onlyIf: { etagMatches: [{ type: 'wildcard' }] } },
				text('value'),
			),
			env,
		);
		expect(missing.status).toBe(412);

		s3.seed(`${KEY_PREFIX}exists.txt`, 'old');
		const decoded = await decode(
			await r2Worker.fetch(
				bodyRequest(
					{ method: 'put', object: 'exists.txt', onlyIf: { etagMatches: [{ type: 'wildcard' }] } },
					text('value'),
				),
				env,
			),
		);
		expect(decoded.status).toBe(200);
		expect(s3.objects.get(`${KEY_PREFIX}exists.txt`)?.body.toString('utf8')).toBe('value');
	});
});

describe('R2 delete', () => {
	test('deletes one key with a single DELETE and a 200 reply', async () => {
		const s3 = new FakeS3();
		s3.seed(`${KEY_PREFIX}hello.txt`, 'hello');
		const env = makeEnv(s3);

		const response = await r2Worker.fetch(
			bodyRequest({ method: 'delete', object: 'hello.txt' }, text('')),
			env,
		);
		expect(response.status).toBe(200);
		expect(s3.requests.map((request) => request.method)).toEqual(['DELETE']);
		expect(s3.requests[0]!.url.pathname).toBe(`/${BUCKET}/${KEY_PREFIX}hello.txt`);
		expect(s3.objects.has(`${KEY_PREFIX}hello.txt`)).toBe(false);
	});

	test('deletes an array with DeleteObjects, an XML body and Content-MD5', async () => {
		const s3 = new FakeS3();
		s3.seed(`${KEY_PREFIX}a.txt`, 'a');
		s3.seed(`${KEY_PREFIX}b.txt`, 'b');
		const env = makeEnv(s3);

		const response = await r2Worker.fetch(
			bodyRequest({ method: 'delete', objects: ['a.txt', 'b.txt'] }, text('')),
			env,
		);
		expect(response.status).toBe(200);
		expect(s3.requests).toHaveLength(1);
		const request = s3.requests[0]!;
		expect(request.method).toBe('POST');
		expect(request.url.searchParams.has('delete')).toBe(true);
		expect(request.body?.toString('utf8')).toContain(`<Key>${KEY_PREFIX}a.txt</Key>`);
		expect(request.body?.toString('utf8')).toContain(`<Key>${KEY_PREFIX}b.txt</Key>`);
		expect(request.headers.get('content-md5')).toBe(createHash('md5').update(request.body!).digest('base64'));
		expect(s3.objects.size).toBe(0);
		verifySignature(request);
	});
});

describe('R2 list', () => {
	test('applies the attachment prefix and returns objects and delimited prefixes', async () => {
		const s3 = new FakeS3();
		s3.seed(`${KEY_PREFIX}2024/a.txt`, 'a');
		s3.seed(`${KEY_PREFIX}root.txt`, 'r');
		s3.seed('other-tenant/secret.txt', 's');
		const env = makeEnv(s3);

		const decoded = await decode(
			await r2Worker.fetch(headerRequest({ method: 'list', delimiter: '/', limit: 100 }), env),
		);
		expect(decoded.status).toBe(200);
		expect(decoded.metadata).toEqual({
			objects: [
				{
					name: 'root.txt',
					version: md5Hex(Buffer.from('r')),
					size: 1,
					etag: md5Hex(Buffer.from('r')),
					uploaded: Date.parse('2026-11-06T10:00:00Z'),
					httpFields: {},
					customFields: [],
					checksums: { 0: md5Hex(Buffer.from('r')) },
				},
			],
			truncated: false,
			delimitedPrefixes: ['2024/'],
		});
		expect(s3.requests[0]!.url.searchParams.get('prefix')).toBe(KEY_PREFIX);
		expect(s3.requests[0]!.url.searchParams.get('delimiter')).toBe('/');
		verifySignature(s3.requests[0]!);
	});

	test('paginates through S3 continuation tokens and keeps them opaque in the cursor', async () => {
		const s3 = new FakeS3();
		for (const name of ['a.txt', 'b.txt', 'c.txt']) s3.seed(`${KEY_PREFIX}${name}`, name);
		const env = makeEnv(s3);

		const first = await decode(await r2Worker.fetch(headerRequest({ method: 'list', limit: 2 }), env));
		expect(first.metadata?.objects.map((object: any) => object.name)).toEqual(['a.txt', 'b.txt']);
		expect(first.metadata?.truncated).toBe(true);
		expect(typeof first.metadata?.cursor).toBe('string');

		const second = await decode(
			await r2Worker.fetch(headerRequest({ method: 'list', limit: 2, cursor: first.metadata!.cursor }), env),
		);
		expect(second.metadata?.objects.map((object: any) => object.name)).toEqual(['c.txt']);
		expect(second.metadata?.truncated).toBe(false);
		expect(second.metadata?.cursor).toBeUndefined();
		// R2's cursor is opaque; the S3 continuation token round-trips through it unchanged.
		const sent = s3.requests[1]!.url.searchParams.get('continuation-token');
		expect(sent).toBe(btoa(`${KEY_PREFIX}b.txt`));
		expect(atob(first.metadata!.cursor)).toBe(sent);
	});

	test('applies a client prefix on top of the attachment prefix and strips it from results', async () => {
		const s3 = new FakeS3();
		s3.seed(`${KEY_PREFIX}app/x.txt`, 'x');
		s3.seed(`${KEY_PREFIX}other/y.txt`, 'y');
		const env = makeEnv(s3);

		const decoded = await decode(
			await r2Worker.fetch(headerRequest({ method: 'list', prefix: 'app/' }), env),
		);
		expect(decoded.metadata?.objects.map((object: any) => object.name)).toEqual(['app/x.txt']);
		expect(s3.requests[0]!.url.searchParams.get('prefix')).toBe(`${KEY_PREFIX}app/`);
	});

	test('fetches metadata for include requests', async () => {
		const s3 = new FakeS3();
		s3.seed(`${KEY_PREFIX}doc.txt`, 'doc', { contentType: 'text/markdown', metadata: { owner: 'ada' } });
		const env = makeEnv(s3);

		// workerd sends include as the numeric R2ListOptions slots: 0 = httpMetadata, 1 = customMetadata.
		const decoded = await decode(
			await r2Worker.fetch(headerRequest({ method: 'list', include: [0, 1] }), env),
		);
		expect(decoded.metadata?.objects[0]).toMatchObject({
			name: 'doc.txt',
			httpFields: { contentType: 'text/markdown' },
			customFields: [{ k: 'owner', v: 'ada' }],
		});
		expect(s3.requests.map((request) => request.method)).toEqual(['GET', 'HEAD']);
	});

	test('rejects an out-of-range limit with InvalidMaxKeys', async () => {
		const s3 = new FakeS3();
		const env = makeEnv(s3);
		for (const limit of [0, 1001]) {
			const response = await r2Worker.fetch(headerRequest({ method: 'list', limit }), env);
			expect(response.status).toBe(400);
			expect(errorBody(response)).toEqual({
				message: 'MaxKeys params must be positive integer <= 1000.',
				version: 1,
				v4code: 10022,
			});
		}
		expect(s3.requests).toHaveLength(0);
	});

	test('treats an empty delimiter as absent', async () => {
		const s3 = new FakeS3();
		s3.seed(`${KEY_PREFIX}a/b.txt`, 'b');
		const env = makeEnv(s3);
		const decoded = await decode(
			await r2Worker.fetch(headerRequest({ method: 'list', delimiter: '' }), env),
		);
		expect(decoded.metadata?.delimitedPrefixes).toEqual([]);
		expect(decoded.metadata?.objects.map((object: any) => object.name)).toEqual(['a/b.txt']);
		expect(s3.requests[0]!.url.searchParams.has('delimiter')).toBe(false);
	});
});

describe('S3 protocol details', () => {
	test('defaults the region to us-east-1 and honours an injected region', async () => {
		const s3 = new FakeS3();
		s3.seed(`${KEY_PREFIX}hello.txt`, 'hello');
		const decoded = await decode(
			await r2Worker.fetch(headerRequest({ method: 'head', object: 'hello.txt' }), makeEnv(s3, { S3_REGION: undefined })),
		);
		expect(decoded.status).toBe(200);
		expect(verifySignature(s3.requests[0]!).region).toBe('us-east-1');

		const other = new FakeS3();
		other.seed(`${KEY_PREFIX}hello.txt`, 'hello');
		await r2Worker.fetch(headerRequest({ method: 'head', object: 'hello.txt' }), makeEnv(other, { S3_REGION: 'eu-west-1' }));
		expect(verifySignature(other.requests[0]!).region).toBe('eu-west-1');
	});

	test('percent-encodes keys without letting them change the endpoint or path structure', async () => {
		const s3 = new FakeS3();
		const env = makeEnv(s3);
		await r2Worker.fetch(bodyRequest({ method: 'put', object: 'a b/é?.txt' }, text('x')), env);
		const request = s3.requests[0]!;
		expect(request.url.origin).toBe(ENDPOINT);
		expect(request.url.pathname).toBe(`/${BUCKET}/${KEY_PREFIX}a%20b/%C3%A9%3F.txt`);
		expect(decodedKey(request)).toBe(`${KEY_PREFIX}a b/é?.txt`);
	});

	test('refuses a key with a dot segment instead of letting URL parsing move it', async () => {
		const s3 = new FakeS3();
		const env = makeEnv(s3);
		const response = await r2Worker.fetch(bodyRequest({ method: 'put', object: 'a/../b.txt' }, text('x')), env);
		expect(response.status).toBe(400);
		expect(errorBody(response)).toMatchObject({
			message: 'The specified object name is not valid.',
			v4code: 10020,
		});
		expect(s3.requests).toHaveLength(0);
	});

	test('never echoes the secret key or access key id in a backend error', async () => {
		const s3 = new FakeS3();
		s3.seed(`${KEY_PREFIX}hello.txt`, 'hello');
		s3.failure = {
			status: 403,
			body:
				'<Error><Code>AccessDenied</Code><Message>The AWS Access Key Id you provided does not exist: ' +
				ACCESS_KEY +
				'</Message></Error>',
		};
		const env = makeEnv(s3);
		const response = await r2Worker.fetch(headerRequest({ method: 'get', object: 'hello.txt' }), env);
		expect(response.status).toBe(500);
		const body = await response.text();
		const headers = JSON.stringify([...response.headers.entries()]);
		expect(body).not.toContain(SECRET_KEY);
		expect(body).not.toContain(ACCESS_KEY);
		expect(headers).not.toContain(SECRET_KEY);
		// The S3 error *code* is safe and useful for debugging.
		expect(errorBody(response).message).toContain('AccessDenied');
	});

	test('refuses to talk to an endpoint whose scheme is not http(s)', async () => {
		const s3 = new FakeS3();
		const response = await r2Worker.fetch(
			headerRequest({ method: 'head', object: 'hello.txt' }),
			makeEnv(s3, { S3_ENDPOINT_URL: 'file:///etc/passwd' }),
		);
		expect(response.status).toBe(500);
		expect(errorBody(response).message).toContain('must be an http(s) URL');
		expect(s3.requests).toHaveLength(0);
	});
});

/** Decode the object path the fake saw back into the key the worker intended. */
function decodedKey(request: RecordedRequest): string {
	const path = request.url.pathname;
	const bucket = `/${BUCKET}/`;
	expect(path.startsWith(bucket)).toBe(true);
	return decodeURIComponent(path.slice(bucket.length));
}

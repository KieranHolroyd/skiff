/**
 * Yoal Cache API binding service.
 *
 * workerd sends `caches.default` / `caches.open(name)` traffic to the service named by a Worker's
 * `cacheApiOutbound` field (`workerd.capnp`). The protocol is the one workerd's cache client
 * speaks, mirrored by Miniflare's cache simulator:
 *
 *   GET  <url>         cached response with `CF-Cache-Status: HIT`, or a 504 MISS
 *   PUT  <url>         body is a serialised HTTP response; stores it, 204 on success / 413 refused
 *   PURGE <url>        deletes one entry, 200 on success / 404 when absent
 *   DELETE /purge-all  `{ deleted: n }` (Yoal admin hook, not part of the workerd protocol)
 *
 * workerd reads the hit/miss verdict from `CF-Cache-Status` (an "EXPIRED"/"UPDATING"/"MISS" reply
 * becomes `undefined` from `cache.match()`), and treats a PUT reply of 204 as stored, 413 as
 * refused, and a PURGE reply of 200/404 as deleted/absent.
 *
 * This is a credible subset of RFC 7234, not a full implementation: Cache-Control
 * `s-maxage`/`max-age`, `Expires`, and a two-hour default TTL; no revalidation, no `Vary`
 * variants, no multipart ranges, and a per-host size cap enforced by refusing new objects.
 *
 * Protocol shape adapted from Miniflare (Apache-2.0), cloudflare/workers-sdk
 * (`packages/miniflare/src/workers/cache`). The storage model is Yoal's: one Durable Object
 * instance per host, plain key/value Durable Object storage, no SQL and no blob disk service.
 */

/** workerd's cache service keys entries by URL. Named caches arrive as a header, not a path. */
const NAMESPACE_HEADER = 'cf-cache-namespace';
/** workerd reads this header to decide whether `cache.match()` returns a Response. */
const CACHE_STATUS_HEADER = 'CF-Cache-Status';

/** Entries are stored under this prefix so one DO can hold every cache namespace. */
const ENTRY_PREFIX = 'entry:';
/** One counter key keeps the size cap O(1) instead of listing every cached body. */
const META_KEY = 'meta';

/** No Cache-Control or Expires: Cloudflare-ish default, kept deliberately simple. */
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
/** Per host: refuse anything bigger (the brief's 16 MiB object cap). */
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
/** Per host: refuse a store that would push the cache over 64 MiB (no eviction). */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** Per host: refuse new keys once the cache holds this many (protects the O(1) counter). */
const MAX_ENTRIES = 10_000;

/** Headers that describe one connection and must never be replayed from a cache entry. */
const HOP_BY_HOP_HEADERS = [
	'connection',
	'keep-alive',
	'proxy-connection',
	'trailer',
	'transfer-encoding',
	'upgrade',
];

/** workerd itself refuses 206 and 304 before they reach `cache.put()`; 1xx is not constructible. */
const STATUS_TEXT_PATTERN = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s+.*)?$/;

/**
 * The single Durable Object behind one function host's Cache API.
 *
 * Storage layout (all plain key/value entries):
 * - `entry:<url>` for the default cache, `entry:named:<encoded name>:<url>` for `caches.open()`;
 *   the value is `{ status, headers: [[name, value]], body: ArrayBuffer, size, expires }`
 *   with `expires` in epoch milliseconds.
 * - `meta`: `{ bytes, count }`, the running total used to enforce the caps.
 *
 * Expiry is lazy: a read, purge or list that sees `expires <= now` removes the entry first.
 * `this.now`, `this.defaultTtlMs` and the three caps are instance fields only so tests can
 * shrink them without allocating 64 MiB of fixtures; production always uses the constants.
 */
export class CacheObject {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.now = () => Date.now();
		this.defaultTtlMs = DEFAULT_TTL_MS;
		this.maxObjectBytes = MAX_OBJECT_BYTES;
		this.maxTotalBytes = MAX_TOTAL_BYTES;
		this.maxEntries = MAX_ENTRIES;
	}

	async fetch(request) {
		switch (request.method) {
			case 'GET':
				return this.match(request);
			case 'PUT':
				return this.put(request);
			case 'PURGE':
				return this.purge(request);
			case 'DELETE':
				return this.purgeAll(request);
			default:
				return new Response(null, { status: 405, headers: { Allow: 'GET, PUT, PURGE' } });
		}
	}

	/** `cache.match()` / `cache.matchAll()`: a hit plus conditional and single-range handling. */
	async match(request) {
		const key = storageKey(request);
		const now = this.now();
		let entry = await this.readEntry(key);
		if (entry && entry.expires <= now) {
			await this.removeEntry(key, entry);
			entry = undefined;
		}
		if (!entry) return cacheMiss();

		const headers = replayHeaders(entry.headers);
		headers.set(CACHE_STATUS_HEADER, 'HIT');

		// If-None-Match is the only revalidation mechanism implemented: workerd's cache client
		// forwards the caller's headers, so a matching ETag becomes a 304 and the Worker can
		// return `cache.match()`'s response directly.
		const ifNoneMatch = request.headers.get('If-None-Match');
		const etag = headers.get('ETag');
		if (ifNoneMatch !== null && etag !== null && etagMatches(ifNoneMatch, etag)) {
			return new Response(null, { status: 304, headers: bodylessHeaders(headers) });
		}

		const range = parseSingleRange(request.headers.get('Range'), entry.size);
		if (range === 'invalid') {
			headers.set('Content-Range', `bytes */${entry.size}`);
			return new Response(null, { status: 416, headers });
		}
		if (range !== null) {
			const body = entry.body.slice(range.start, range.end + 1);
			headers.set('Content-Range', `bytes ${range.start}-${range.end}/${entry.size}`);
			headers.set('Content-Length', String(body.byteLength));
			return new Response(body, { status: 206, headers });
		}

		// 204, 205 and 304 are null-body statuses: the Response constructor rejects even an
		// empty ArrayBuffer for them, which is why a cached 204 is served with a null body.
		if (entry.status === 204 || entry.status === 205 || entry.status === 304) {
			return new Response(null, { status: entry.status, headers: bodylessHeaders(headers) });
		}
		headers.set('Content-Length', String(entry.size));
		// Copy the stored buffer: a Response may take ownership of, and detach, an ArrayBuffer.
		return new Response(entry.body.slice(0), { status: entry.status, headers });
	}

	/** `cache.put()`: parse the serialised response, decide cacheability, store or refuse. */
	async put(request) {
		let parsed;
		try {
			parsed = parseSerializedResponse(await request.arrayBuffer());
		} catch {
			// workerd only ever sends a well-formed serialised response; refuse malformed input
			// rather than store a half-understood entry.
			return new Response(null, { status: 400 });
		}

		const now = this.now();
		const policy = cacheability(parsed.headers, now, this.defaultTtlMs);
		if (!policy.storable) return new Response(null, { status: 413 });

		if (parsed.size > this.maxObjectBytes) return new Response(null, { status: 413 });

		const storage = this.state.storage;
		const key = storageKey(request);
		const meta = await readMeta(storage);
		const existing = await this.readEntry(key);
		const replacedBytes = existing ? existing.size : 0;
		const replacedCount = existing ? 1 : 0;
		if (meta.bytes - replacedBytes + parsed.size > this.maxTotalBytes)
			return new Response(null, { status: 413 });
		if (meta.count - replacedCount + 1 > this.maxEntries) return new Response(null, { status: 413 });

		/** @type {{ status: number, headers: [string, string][], body: ArrayBuffer, size: number, expires: number }} */
		const entry = {
			status: parsed.status,
			headers: parsed.headers,
			body: parsed.body,
			size: parsed.size,
			expires: now + policy.ttl,
		};
		await storage.put(key, entry);
		await writeMeta(storage, {
			bytes: meta.bytes - replacedBytes + parsed.size,
			count: meta.count - replacedCount + 1,
		});
		return new Response(null, { status: 204 });
	}

	/** `cache.delete()`: 200 when an entry was removed, 404 when there was nothing to remove. */
	async purge(request) {
		const key = storageKey(request);
		const entry = await this.readEntry(key);
		if (!entry) return new Response(null, { status: 404 });
		if (entry.expires <= this.now()) {
			await this.removeEntry(key, entry);
			return new Response(null, { status: 404 });
		}
		await this.removeEntry(key, entry);
		return new Response(null, { status: 200 });
	}

	/** `DELETE /purge-all`: Yoal's administrative clear, `{ deleted: n }`. */
	async purgeAll(request) {
		const path = pathname(request.url);
		if (path !== '/purge-all') return new Response(null, { status: 404 });
		const storage = this.state.storage;
		const entries = await storage.list({ prefix: ENTRY_PREFIX });
		const keys = [...entries.keys()];
		if (keys.length > 0) await storage.delete(keys);
		await writeMeta(storage, { bytes: 0, count: 0 });
		return Response.json({ deleted: keys.length });
	}

	async readEntry(key) {
		const entry = await this.state.storage.get(key);
		if (
			!entry ||
			typeof entry !== 'object' ||
			typeof entry.size !== 'number' ||
			typeof entry.expires !== 'number' ||
			typeof entry.status !== 'number' ||
			!Array.isArray(entry.headers) ||
			!(entry.body instanceof ArrayBuffer)
		)
			return undefined;
		return entry;
	}

	async removeEntry(key, entry) {
		const storage = this.state.storage;
		await storage.delete(key);
		const meta = await readMeta(storage);
		await writeMeta(storage, {
			bytes: Math.max(0, meta.bytes - entry.size),
			count: Math.max(0, meta.count - 1),
		});
	}
}

/**
 * Entry point workerd reaches through `cacheApiOutbound`. One DO holds every namespace on the
 * host (named caches are separated by a key prefix in {@link storageKey}), so the size cap is a
 * true per-host cap and `purge-all` can clear all of them.
 */
export default {
	async fetch(request, env) {
		const id = env.DO.idFromName('default');
		return env.DO.get(id).fetch(request);
	},
};

/** The cache key: workerd's URL, or `request.cf.cacheKey` when the caller set one. */
function cacheKey(request) {
	const override = request.cf && request.cf.cacheKey;
	return typeof override === 'string' && override.length > 0 ? override : request.url;
}

/** Storage key for a request. `caches.open(name)` arrives as `cf-cache-namespace`. */
function storageKey(request) {
	const namespace = request.headers.get(NAMESPACE_HEADER);
	if (namespace === null || namespace === '') return `${ENTRY_PREFIX}${cacheKey(request)}`;
	return `${ENTRY_PREFIX}named:${encodeURIComponent(namespace)}:${cacheKey(request)}`;
}

/**
 * Parse the PUT payload: an HTTP/1.x response with no chunked encoding, as workerd serialises it.
 * Returns the status, the header pairs as sent (case preserved), and the body as an ArrayBuffer.
 */
function parseSerializedResponse(input) {
	const bytes = new Uint8Array(input);
	let separator = -1;
	for (let index = 0; index + 3 < bytes.length; index += 1) {
		if (
			bytes[index] === 13 &&
			bytes[index + 1] === 10 &&
			bytes[index + 2] === 13 &&
			bytes[index + 3] === 10
		) {
			separator = index;
			break;
		}
	}
	if (separator === -1) throw new Error('The cache PUT payload has no header terminator.');

	const lines = latin1(bytes, separator).split('\r\n');
	const statusMatch = STATUS_TEXT_PATTERN.exec(lines[0]);
	if (!statusMatch) throw new Error('The cache PUT payload has no HTTP status line.');
	const status = Number(statusMatch[1]);
	if (!Number.isInteger(status) || status < 200 || status > 599)
		throw new Error('The cache PUT payload has an unsupported status code.');

	const headers = [];
	for (const line of lines.slice(1)) {
		if (line.length === 0) continue;
		const colon = line.indexOf(':');
		if (colon <= 0) throw new Error('The cache PUT payload has a malformed header line.');
		headers.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
	}

	const body = input.slice(separator + 4);
	return { status, headers, body, size: body.byteLength };
}

/** Header region bytes are ISO-8859-1; map them one-to-one so no UTF-8 assumption is made. */
function latin1(bytes, end) {
	let text = '';
	for (let index = 0; index < end; index += 1) text += String.fromCharCode(bytes[index]);
	return text;
}

/**
 * Decide whether a response may be stored and for how long.
 *
 * Refused: `Cache-Control: no-store`, `private` or `no-cache`, and any response with a
 * `Set-Cookie` header (Cloudflare never caches those either). TTL comes from `s-maxage`, then
 * `max-age` (seconds), then `Expires`, then the two-hour default; a non-positive TTL is stored
 * with `expires = now`, so it is simply never a hit.
 */
function cacheability(headers, now, defaultTtlMs) {
	if (hasHeader(headers, 'set-cookie')) return { storable: false, ttl: 0 };
	const directives = parseCacheControl(headerValue(headers, 'cache-control'));
	if (directives.has('no-store') || directives.has('private') || directives.has('no-cache'))
		return { storable: false, ttl: 0 };

	let ttl = numericDirective(directives, 's-maxage');
	if (ttl === null) ttl = numericDirective(directives, 'max-age');
	let milliseconds = ttl === null ? null : ttl * 1000;
	if (milliseconds === null) {
		const expires = parseHttpDate(headerValue(headers, 'expires'));
		if (expires !== null) milliseconds = expires - now;
	}
	if (milliseconds === null) milliseconds = defaultTtlMs;
	return { storable: true, ttl: Math.max(0, milliseconds) };
}

/**
 * RFC 1123 date, the only form HTTP/1.1 `Expires` is allowed to use. Unlike `Date.parse`, this
 * rejects loose strings such as "0" that engines otherwise interpret as a date.
 */
function parseHttpDate(value) {
	if (!value) return null;
	const utcDatePattern =
		/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d\d (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d\d\d\d \d\d:\d\d:\d\d GMT$/;
	if (!utcDatePattern.test(value)) return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

function parseCacheControl(value) {
	const directives = new Map();
	if (!value) return directives;
	for (const part of value.split(',')) {
		const trimmed = part.trim();
		if (trimmed.length === 0) continue;
		const equals = trimmed.indexOf('=');
		const name = (equals === -1 ? trimmed : trimmed.slice(0, equals)).trim().toLowerCase();
		let argument = equals === -1 ? '' : trimmed.slice(equals + 1).trim();
		if (argument.length >= 2 && argument.startsWith('"') && argument.endsWith('"'))
			argument = argument.slice(1, -1);
		if (name.length > 0 && !directives.has(name)) directives.set(name, argument);
	}
	return directives;
}

function numericDirective(directives, name) {
	const raw = directives.get(name);
	if (raw === undefined || raw.trim() === '') return null;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : null;
}

/** First value for `name`, case-insensitively, or undefined. */
function headerValue(headers, name) {
	const lower = name.toLowerCase();
	for (const [name, value] of headers) {
		if (name.toLowerCase() === lower) return value;
	}
	return undefined;
}

function hasHeader(headers, name) {
	return headerValue(headers, name) !== undefined;
}

/** Turn stored header pairs into Response headers, dropping connection-specific ones. */
function replayHeaders(pairs) {
	const headers = new Headers();
	for (const [name, value] of pairs) {
		if (HOP_BY_HOP_HEADERS.includes(name.toLowerCase())) continue;
		headers.append(name, value);
	}
	headers.delete(CACHE_STATUS_HEADER);
	return headers;
}

/** 304/204 responses carry no body, so a stored Content-Length would be misleading. */
function bodylessHeaders(headers) {
	headers.delete('Content-Length');
	headers.delete('Content-Range');
	return headers;
}

/** The exact 504 MISS workerd's cache client turns into `undefined` from `cache.match()`. */
function cacheMiss() {
	return new Response(null, {
		status: 504,
		headers: { [CACHE_STATUS_HEADER]: 'MISS' },
	});
}

/** Weak ETag comparison, as required for If-None-Match (RFC 7232 §2.3.2). */
function etagMatches(header, responseETag) {
	const responseTag = parseETag(responseETag);
	if (responseTag === undefined) return false;
	if (header.trim() === '*') return true;
	for (const candidate of header.split(',')) {
		if (parseETag(candidate) === responseTag) return true;
	}
	return false;
}

function parseETag(value) {
	const match = /^(W\/)?"(.*)"$/.exec(value.trim());
	return match ? match[2] : undefined;
}

/**
 * One `bytes=` range, or `null` to ignore the header (multi-range and non-byte units fall back to
 * a full 200, which RFC 7233 allows), or `'invalid'` for a 416.
 */
function parseSingleRange(header, size) {
	if (header === null) return null;
	const value = header.trim();
	if (!value.toLowerCase().startsWith('bytes=')) return null;
	const spec = value.slice('bytes='.length).trim();
	if (spec.length === 0 || spec.includes(',')) return null;
	const match = /^(\d*)-(\d*)$/.exec(spec);
	if (!match) return 'invalid';
	const [, rawStart, rawEnd] = match;
	if (rawStart === '' && rawEnd === '') return 'invalid';
	if (rawStart === '') {
		const suffix = Number(rawEnd);
		if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return 'invalid';
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(rawStart);
	if (!Number.isSafeInteger(start) || start >= size) return 'invalid';
	let end = rawEnd === '' ? size - 1 : Number(rawEnd);
	if (!Number.isSafeInteger(end) || end < start) return 'invalid';
	if (end >= size) end = size - 1;
	return { start, end };
}

function pathname(url) {
	try {
		return new URL(url).pathname;
	} catch {
		return '';
	}
}

async function readMeta(storage) {
	const meta = await storage.get(META_KEY);
	if (!meta || typeof meta.bytes !== 'number' || typeof meta.count !== 'number')
		return { bytes: 0, count: 0 };
	return { bytes: Math.max(0, meta.bytes), count: Math.max(0, meta.count) };
}

async function writeMeta(storage, meta) {
	await storage.put(META_KEY, meta);
}

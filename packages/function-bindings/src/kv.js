/**
 * Yoal KV binding service (docs/FUNCTIONS.md §4.5, FN10).
 *
 * A Worker that implements the workerd KV binding protocol on top of one Durable Object's
 * key/value storage. The user Worker gets a `kvNamespace` binding pointing at this service; workerd
 * then talks to it over HTTP exactly as it would to Cloudflare's KV.
 *
 * Protocol shape adapted from Miniflare (Apache-2.0), cloudflare/workers-sdk:
 * packages/miniflare/src/workers/kv/{namespace,validator,constants}.worker.ts.
 *
 * Plain JavaScript ESM: workerd loads this file as text and embeds it as a module. No imports, no
 * Node APIs, no eval, only Web APIs and Durable Object storage.
 */

const MAX_KEY_SIZE_BYTES = 512;
const MAX_VALUE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MiB, Cloudflare's KV limit.
const MAX_METADATA_SIZE_BYTES = 1024; // 1 KiB.
const MAX_LIST_KEYS = 1000;
const MAX_BULK_GET_KEYS = 100;
const MAX_BULK_SIZE_BYTES = 25 * 1024 * 1024;
const MIN_EXPIRATION_TTL_SECONDS = 60;

const EXPIRATION_HEADER = 'CF-Expiration';
const METADATA_HEADER = 'CF-KV-Metadata';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** An error that maps to an HTTP response, mirroring Miniflare's `HttpError`. */
class KvHttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

function textResponse(message, status) {
	return new Response(message, {
		status,
		headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
	});
}

function jsonResponse(value) {
	return new Response(JSON.stringify(value), {
		headers: { 'Content-Type': 'application/json' },
	});
}

function byteLength(value) {
	return textEncoder.encode(value).byteLength;
}

function nowSeconds() {
	return Math.floor(Date.now() / 1000);
}

/**
 * The key is a URL path segment. workerd always appends `?urlencoded=true` and percent-encodes the
 * key (see src/workerd/api/kv.c++), which is also what Miniflare's `decodeKey` expects.
 */
function decodeKey(url) {
	const raw = url.pathname.slice(1);
	if (url.searchParams.get('urlencoded')?.toLowerCase() !== 'true') return raw;
	try {
		return decodeURIComponent(raw);
	} catch {
		throw new KvHttpError(400, 'Could not URL-decode key name');
	}
}

function validateKeyLength(key) {
	const length = byteLength(key);
	if (length > MAX_KEY_SIZE_BYTES) {
		throw new KvHttpError(
			414,
			`UTF-8 encoded length of ${length} exceeds key length limit of ${MAX_KEY_SIZE_BYTES}.`,
		);
	}
}

function validateKey(key) {
	if (key === '') throw new KvHttpError(400, 'Key names must not be empty');
	if (key === '.' || key === '..') {
		throw new KvHttpError(400, `Illegal key name "${key}". Please use a different name.`);
	}
	validateKeyLength(key);
}

/**
 * Parse `expiration` (epoch seconds) or `expiration_ttl` (seconds from now), returning an absolute
 * expiry in milliseconds. Both rules and messages match Miniflare's validator.
 */
function parseExpiration(searchParams) {
	const rawTtl = searchParams.get('expiration_ttl');
	if (rawTtl !== null) {
		const ttl = Number.parseInt(rawTtl, 10);
		if (Number.isNaN(ttl) || ttl <= 0) {
			throw new KvHttpError(
				400,
				`Invalid expiration_ttl of ${rawTtl}. Please specify integer greater than 0.`,
			);
		}
		if (ttl < MIN_EXPIRATION_TTL_SECONDS) {
			throw new KvHttpError(
				400,
				`Invalid expiration_ttl of ${rawTtl}. Expiration TTL must be at least ${MIN_EXPIRATION_TTL_SECONDS}.`,
			);
		}
		return (nowSeconds() + ttl) * 1000;
	}

	const rawExpiration = searchParams.get('expiration');
	if (rawExpiration !== null) {
		const now = nowSeconds();
		const expiration = Number.parseInt(rawExpiration, 10);
		if (Number.isNaN(expiration) || expiration <= now) {
			throw new KvHttpError(
				400,
				`Invalid expiration of ${rawExpiration}. Please specify integer greater than the current number of seconds since the UNIX epoch.`,
			);
		}
		if (expiration < now + MIN_EXPIRATION_TTL_SECONDS) {
			throw new KvHttpError(
				400,
				`Invalid expiration of ${rawExpiration}. Expiration times must be at least ${MIN_EXPIRATION_TTL_SECONDS} seconds in the future.`,
			);
		}
		return expiration * 1000;
	}

	return undefined;
}

function parseMetadata(request) {
	const raw = request.headers.get(METADATA_HEADER);
	if (raw === null) return undefined;
	const length = byteLength(raw);
	if (length > MAX_METADATA_SIZE_BYTES) {
		throw new KvHttpError(
			413,
			`Metadata length of ${length} exceeds limit of ${MAX_METADATA_SIZE_BYTES}.`,
		);
	}
	try {
		return JSON.parse(raw);
	} catch {
		throw new KvHttpError(400, 'Metadata is not valid JSON.');
	}
}

/** Fetch a live entry, deleting it lazily if its expiry has passed. */
async function readEntry(storage, key) {
	const entry = await storage.get(key);
	if (entry === undefined || entry === null) return null;
	if (typeof entry.e === 'number' && entry.e <= Date.now()) {
		await storage.delete(key);
		return null;
	}
	return entry;
}

function valueAsText(entry) {
	return typeof entry.v === 'string' ? entry.v : textDecoder.decode(entry.v);
}

function valueAsBytes(entry) {
	return typeof entry.v === 'string' ? byteLength(entry.v) : entry.v.byteLength;
}

export class KVNamespaceObject {
	constructor(state, env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request) {
		try {
			return await this.route(request);
		} catch (error) {
			if (error instanceof KvHttpError) return textResponse(error.message, error.status);
			throw error;
		}
	}

	async route(request) {
		const url = new URL(request.url);

		if (request.method === 'POST' && url.pathname === '/bulk/get') return this.bulkGet(request);
		if (request.method === 'GET' && url.pathname === '/') return this.list(url);

		const key = decodeKey(url);
		switch (request.method) {
			case 'GET':
				return this.get(key);
			case 'PUT':
				return this.put(request, url, key);
			case 'DELETE':
				return this.delete(key);
			default:
				return textResponse('Method Not Allowed', 405);
		}
	}

	async get(key) {
		validateKey(key);
		const entry = await readEntry(this.state.storage, key);
		if (entry === null) return textResponse('Not Found', 404);

		const headers = new Headers();
		if (typeof entry.e === 'number') {
			headers.set(EXPIRATION_HEADER, String(Math.floor(entry.e / 1000)));
		}
		if (entry.m !== undefined) headers.set(METADATA_HEADER, JSON.stringify(entry.m));
		return new Response(entry.v, { headers });
	}

	async put(request, url, key) {
		validateKey(key);
		const expiration = parseExpiration(url.searchParams);
		const metadata = parseMetadata(request);

		const body = await request.arrayBuffer();
		if (body.byteLength > MAX_VALUE_SIZE_BYTES) {
			throw new KvHttpError(
				413,
				`Value length of ${body.byteLength} exceeds limit of ${MAX_VALUE_SIZE_BYTES}.`,
			);
		}

		// workerd sends strings with a text content type and binary bodies without one
		// (src/workerd/api/kv.c++ `put()`), so the request type survives the round trip.
		const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
		const value = contentType.startsWith('text/') ? textDecoder.decode(body) : body;

		const entry = { v: value };
		if (metadata !== undefined) entry.m = metadata;
		if (expiration !== undefined) entry.e = expiration;
		await this.state.storage.put(key, entry);
		return new Response(null, { status: 200 });
	}

	async delete(key) {
		validateKey(key);
		await this.state.storage.delete(key);
		return new Response(null, { status: 200 });
	}

	async list(url) {
		const prefix = url.searchParams.get('prefix') ?? undefined;
		const rawLimit = url.searchParams.get('key_count_limit');
		const limit = rawLimit === null ? MAX_LIST_KEYS : Number.parseInt(rawLimit, 10);
		if (Number.isNaN(limit) || limit < 1) {
			throw new KvHttpError(
				400,
				`Invalid key_count_limit of ${limit}. Please specify an integer greater than 0.`,
			);
		}
		if (limit > MAX_LIST_KEYS) {
			throw new KvHttpError(
				400,
				`Invalid key_count_limit of ${limit}. Please specify an integer less than ${MAX_LIST_KEYS}.`,
			);
		}
		if (prefix !== undefined) validateKeyLength(prefix);

		const cursor = url.searchParams.get('cursor') ?? undefined;
		// Ask for one extra key: its presence is how we know a cursor is needed.
		const options = { limit: limit + 1 };
		if (prefix !== undefined) options.prefix = prefix;
		if (cursor !== undefined && cursor !== '') options.startAfter = cursor;

		const page = await this.state.storage.list(options);
		const entries = Array.from(page.entries());
		const hasMore = entries.length > limit;
		const visible = entries.slice(0, limit);

		const keys = [];
		const expired = [];
		for (const [name, entry] of visible) {
			if (typeof entry.e === 'number' && entry.e <= Date.now()) {
				expired.push(name);
				continue;
			}
			const item = { name };
			if (typeof entry.e === 'number') item.expiration = Math.floor(entry.e / 1000);
			// workerd expects metadata as a JSON string in a list response, unlike GET's header.
			if (entry.m !== undefined) item.metadata = JSON.stringify(entry.m);
			keys.push(item);
		}
		if (expired.length > 0) {
			await Promise.all(expired.map((name) => this.state.storage.delete(name)));
		}

		const result = { keys, list_complete: !hasMore, cacheStatus: null };
		if (hasMore) result.cursor = visible[visible.length - 1][0];
		return jsonResponse(result);
	}

	async bulkGet(request) {
		let payload;
		try {
			payload = await request.json();
		} catch {
			throw new KvHttpError(400, 'Invalid JSON body.');
		}

		const keys = payload?.keys;
		if (!Array.isArray(keys)) throw new KvHttpError(400, 'You must request an array of keys');
		if (keys.length > MAX_BULK_GET_KEYS) {
			throw new KvHttpError(400, `You can request a maximum of ${MAX_BULK_GET_KEYS} keys`);
		}
		if (keys.length < 1) throw new KvHttpError(400, 'You must request a minimum of 1 key');

		const type = payload?.type;
		if (type !== undefined && type !== 'text' && type !== 'json') {
			throw new KvHttpError(400, `"${type}" is not a valid type. Use "json" or "text"`);
		}
		const withMetadata = payload?.withMetadata === true;

		// A null prototype keeps a key named "__proto__" an ordinary result entry.
		const result = Object.create(null);
		let totalBytes = 0;
		for (const key of keys) {
			if (typeof key !== 'string') throw new KvHttpError(400, 'Keys must be strings');
			validateKey(key);
			const entry = await readEntry(this.state.storage, key);
			let value = null;
			if (entry !== null) {
				const text = valueAsText(entry);
				if (type === 'json') {
					try {
						value = JSON.parse(text);
					} catch {
						throw new KvHttpError(
							400,
							'At least one of the requested keys corresponds to a non-json value',
						);
					}
				} else {
					value = text;
				}
				totalBytes += valueAsBytes(entry);
			}
			result[key] = value !== null && withMetadata ? { value, metadata: entry?.m ?? null } : value;
		}

		if (totalBytes > MAX_BULK_SIZE_BYTES) {
			throw new KvHttpError(
				413,
				`Total size of request exceeds the limit of ${MAX_BULK_SIZE_BYTES / 1024 / 1024}MB`,
			);
		}
		return jsonResponse(result);
	}
}

export default {
	async fetch(request, env) {
		const id = env.DO.idFromName('default');
		return env.DO.get(id).fetch(request);
	},
};

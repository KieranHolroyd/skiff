import { describe, expect, test } from 'bun:test';
import cacheWorker, { CacheObject } from './cache.js';

/**
 * Fake Durable Object storage: the subset the cache service uses (`get`, `put`, `delete` with one
 * key or an array, and `list({ prefix })` returning a Map in key order).
 */
class FakeStorage {
	readonly map = new Map<string, unknown>();

	async get(key: string): Promise<unknown> {
		const value = this.map.get(key);
		return value === undefined ? undefined : structuredClone(value);
	}

	async put(key: string, value: unknown): Promise<void> {
		// Real DO storage structured-clones values, so tests must not share mutable buffers.
		this.map.set(key, structuredClone(value));
	}

	async delete(key: string | string[]): Promise<void> {
		for (const entry of Array.isArray(key) ? key : [key]) this.map.delete(entry);
	}

	async list(options: { prefix?: string } = {}): Promise<Map<string, unknown>> {
		const prefix = options.prefix ?? '';
		const result = new Map<string, unknown>();
		for (const key of [...this.map.keys()].sort()) {
			if (!key.startsWith(prefix)) continue;
			result.set(key, structuredClone(this.map.get(key)));
		}
		return result;
	}
}

interface Harness {
	cache: CacheObject;
	storage: FakeStorage;
	setNow(value: number): void;
	advance(by: number): void;
}

function harness(start = 1_700_000_000_000): Harness {
	const storage = new FakeStorage();
	// The service stores `{ status, headers, body, size, expires }` per entry.
	const cache = new CacheObject({ storage }, {} as never);
	let now = start;
	cache.now = () => now;
	return {
		cache,
		storage,
		setNow(value) {
			now = value;
		},
		advance(by) {
			now += by;
		},
	};
}

/** Serialise a response exactly the way workerd's cache client sends it to the cache service. */
function serialize(
	status: number,
	headers: Record<string, string> = {},
	body: string | Uint8Array = '',
): Uint8Array {
	const bodyBytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
	let head = `HTTP/1.1 ${status} OK\r\n`;
	for (const [name, value] of Object.entries(headers)) head += `${name}: ${value}\r\n`;
	head += '\r\n';
	const headBytes = new TextEncoder().encode(head);
	const payload = new Uint8Array(headBytes.byteLength + bodyBytes.byteLength);
	payload.set(headBytes);
	payload.set(bodyBytes, headBytes.byteLength);
	return payload;
}

function put(cache: CacheObject, url: string, body: Uint8Array, headers: Record<string, string> = {}) {
	return cache.fetch(new Request(url, { method: 'PUT', body, headers }));
}

function get(cache: CacheObject, url: string, headers: Record<string, string> = {}) {
	return cache.fetch(new Request(url, { headers }));
}

function purge(cache: CacheObject, url: string) {
	return cache.fetch(new Request(url, { method: 'PURGE' }));
}

const URL_ONE = 'https://app.example/assets/app.js';

describe('CacheObject store and match', () => {
	test('stores a serialised response and serves it back as a HIT', async () => {
		const { cache } = harness();
		const stored = await put(
			cache,
			URL_ONE,
			serialize(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=60' }, 'console.log(1)'),
		);
		expect(stored.status).toBe(204);
		expect(stored.headers.get('Content-Length')).toBeNull();

		const hit = await get(cache, URL_ONE);
		expect(hit.status).toBe(200);
		expect(hit.headers.get('CF-Cache-Status')).toBe('HIT');
		expect(hit.headers.get('Content-Type')).toBe('text/javascript');
		expect(hit.headers.get('Content-Length')).toBe('14');
		expect(await hit.text()).toBe('console.log(1)');
	});

	test('preserves a non-200 status', async () => {
		const { cache } = harness();
		await put(cache, URL_ONE, serialize(404, { 'Cache-Control': 'max-age=60' }, 'not here'));
		const hit = await get(cache, URL_ONE);
		expect(hit.status).toBe(404);
		expect(hit.headers.get('CF-Cache-Status')).toBe('HIT');
		expect(await hit.text()).toBe('not here');
	});

	test('serves a cached null-body status (204) without a body', async () => {
		const { cache } = harness();
		expect((await put(cache, URL_ONE, serialize(204, { 'Cache-Control': 'max-age=60' }))).status).toBe(204);
		const hit = await get(cache, URL_ONE);
		expect(hit.status).toBe(204);
		expect(hit.headers.get('Content-Length')).toBeNull();
		expect(await hit.text()).toBe('');
	});

	test('a miss is a 504 with CF-Cache-Status: MISS and no body', async () => {
		const { cache } = harness();
		const miss = await get(cache, URL_ONE);
		expect(miss.status).toBe(504);
		expect(miss.headers.get('CF-Cache-Status')).toBe('MISS');
		expect(await miss.text()).toBe('');
	});

	test('binary bodies survive byte for byte, including embedded CRLFCRLF', async () => {
		const { cache } = harness();
		const body = new Uint8Array([0, 1, 2, 13, 10, 13, 10, 255, 254, 0, 13, 10]);
		await put(cache, URL_ONE, serialize(200, { 'Cache-Control': 'max-age=60' }, body));
		const hit = await get(cache, URL_ONE);
		expect(new Uint8Array(await hit.arrayBuffer())).toEqual(body);
	});

	test('namespaced caches (caches.open) are isolated from the default cache', async () => {
		const { cache } = harness();
		const named = new Request(URL_ONE, {
			method: 'PUT',
			body: serialize(200, { 'Cache-Control': 'max-age=60' }, 'named'),
			headers: { 'cf-cache-namespace': 'images' },
		});
		expect((await cache.fetch(named)).status).toBe(204);

		expect((await get(cache, URL_ONE)).status).toBe(504);
		const hit = await get(cache, URL_ONE, { 'cf-cache-namespace': 'images' });
		expect(hit.status).toBe(200);
		expect(await hit.text()).toBe('named');
	});
});

describe('CacheObject conditional and range requests', () => {
	test('If-None-Match with a matching ETag returns 304 and no body', async () => {
		const { cache } = harness();
		await put(cache, URL_ONE, serialize(200, { 'Cache-Control': 'max-age=60', ETag: '"v1"' }, 'body'));
		const notModified = await get(cache, URL_ONE, { 'If-None-Match': 'W/"v1"' });
		expect(notModified.status).toBe(304);
		expect(notModified.headers.get('CF-Cache-Status')).toBe('HIT');
		expect(await notModified.text()).toBe('');
	});

	test('If-None-Match with a different ETag returns the full response', async () => {
		const { cache } = harness();
		await put(cache, URL_ONE, serialize(200, { 'Cache-Control': 'max-age=60', ETag: '"v1"' }, 'body'));
		const hit = await get(cache, URL_ONE, { 'If-None-Match': '"v2"' });
		expect(hit.status).toBe(200);
		expect(await hit.text()).toBe('body');
	});

	test('serves one byte range as 206 with Content-Range and Content-Length', async () => {
		const { cache } = harness();
		await put(cache, URL_ONE, serialize(200, { 'Cache-Control': 'max-age=60' }, 'hello world'));

		const first = await get(cache, URL_ONE, { Range: 'bytes=0-4' });
		expect(first.status).toBe(206);
		expect(first.headers.get('Content-Range')).toBe('bytes 0-4/11');
		expect(first.headers.get('Content-Length')).toBe('5');
		expect(first.headers.get('CF-Cache-Status')).toBe('HIT');
		expect(await first.text()).toBe('hello');

		const suffix = await get(cache, URL_ONE, { Range: 'bytes=-5' });
		expect(await suffix.text()).toBe('world');

		const open = await get(cache, URL_ONE, { Range: 'bytes=6-' });
		expect(await open.text()).toBe('world');
	});

	test('an unsatisfiable range is 416 with bytes */size', async () => {
		const { cache } = harness();
		await put(cache, URL_ONE, serialize(200, { 'Cache-Control': 'max-age=60' }, 'hello world'));
		const unsatisfiable = await get(cache, URL_ONE, { Range: 'bytes=50-' });
		expect(unsatisfiable.status).toBe(416);
		expect(unsatisfiable.headers.get('Content-Range')).toBe('bytes */11');
		expect(await unsatisfiable.text()).toBe('');
	});

	test('a multi-range request falls back to the full 200 response', async () => {
		const { cache } = harness();
		await put(cache, URL_ONE, serialize(200, { 'Cache-Control': 'max-age=60' }, 'hello world'));
		const multi = await get(cache, URL_ONE, { Range: 'bytes=0-1,3-4' });
		expect(multi.status).toBe(200);
		expect(await multi.text()).toBe('hello world');
	});
});

describe('CacheObject purge', () => {
	test('purge removes one entry, 200 then 404, and a later GET misses', async () => {
		const { cache } = harness();
		await put(cache, URL_ONE, serialize(200, { 'Cache-Control': 'max-age=60' }, 'body'));

		const purged = await purge(cache, URL_ONE);
		expect(purged.status).toBe(200);
		expect(await purged.text()).toBe('');
		expect((await get(cache, URL_ONE)).status).toBe(504);
		expect((await purge(cache, URL_ONE)).status).toBe(404);
	});

	test('purging an expired entry is a 404 and cleans it up', async () => {
		const { cache, storage, advance } = harness();
		await put(cache, URL_ONE, serialize(200, { 'Cache-Control': 'max-age=1' }, 'body'));
		advance(2_000);
		expect((await purge(cache, URL_ONE)).status).toBe(404);
		expect([...storage.map.keys()]).toEqual(['meta']);
	});

	test('purge-all clears every namespace and reports the count', async () => {
		const { cache, storage } = harness();
		await put(cache, URL_ONE, serialize(200, { 'Cache-Control': 'max-age=60' }, 'one'));
		await put(cache, 'https://app.example/assets/two.css', serialize(200, { 'Cache-Control': 'max-age=60' }, 'two'));
		const named = new Request('https://app.example/assets/three.png', {
			method: 'PUT',
			body: serialize(200, { 'Cache-Control': 'max-age=60' }, 'three'),
			headers: { 'cf-cache-namespace': 'images' },
		});
		await cache.fetch(named);

		const cleared = await cache.fetch(new Request('https://cache.internal/purge-all', { method: 'DELETE' }));
		expect(await cleared.json()).toEqual({ deleted: 3 });
		expect([...storage.map.keys()]).toEqual(['meta']);
		expect((await get(cache, URL_ONE)).status).toBe(504);
		expect((await get(cache, 'https://app.example/assets/three.png', { 'cf-cache-namespace': 'images' })).status).toBe(504);

		const empty = await cache.fetch(new Request('https://cache.internal/purge-all', { method: 'DELETE' }));
		expect(await empty.json()).toEqual({ deleted: 0 });
	});

	test('DELETE on any other path is a 404', async () => {
		const { cache } = harness();
		const response = await cache.fetch(new Request('https://cache.internal/other', { method: 'DELETE' }));
		expect(response.status).toBe(404);
	});
});

describe('CacheObject expiration', () => {
	test('max-age is honoured and an expired entry is lazily removed', async () => {
		const { cache, storage, advance } = harness();
		await put(cache, URL_ONE, serialize(200, { 'Cache-Control': 'max-age=60' }, 'body'));
		advance(59_999);
		expect((await get(cache, URL_ONE)).status).toBe(200);
		advance(2);
		expect((await get(cache, URL_ONE)).status).toBe(504);
		expect([...storage.map.keys()]).toEqual(['meta']);
	});

	test('s-maxage wins over max-age', async () => {
		const { cache, advance } = harness();
		await put(cache, URL_ONE, serialize(200, { 'Cache-Control': 'max-age=1, s-maxage=60' }, 'body'));
		advance(2_000);
		expect((await get(cache, URL_ONE)).status).toBe(200);
	});

	test('Expires sets the TTL when Cache-Control does not', async () => {
		const { cache, setNow } = harness();
		setNow(Date.parse('2026-11-06T12:00:00Z'));
		const expires = new Date(Date.parse('2026-11-06T12:00:30Z')).toUTCString();
		await put(cache, URL_ONE, serialize(200, { Expires: expires }, 'body'));
		setNow(Date.parse('2026-11-06T12:00:29Z'));
		expect((await get(cache, URL_ONE)).status).toBe(200);
		setNow(Date.parse('2026-11-06T12:00:30Z'));
		expect((await get(cache, URL_ONE)).status).toBe(504);
	});

	test('the default TTL is two hours', async () => {
		const { cache, advance } = harness();
		await put(cache, URL_ONE, serialize(200, {}, 'body'));
		advance(7_199_999);
		expect((await get(cache, URL_ONE)).status).toBe(200);
		advance(2);
		expect((await get(cache, URL_ONE)).status).toBe(504);
	});

	test('an invalid Expires falls back to the default TTL', async () => {
		const { cache, advance } = harness();
		await put(cache, URL_ONE, serialize(200, { Expires: '0' }, 'body'));
		advance(7_199_999);
		expect((await get(cache, URL_ONE)).status).toBe(200);
		advance(2);
		expect((await get(cache, URL_ONE)).status).toBe(504);
	});

	test('max-age=0 is stored but never a hit', async () => {
		const { cache, advance } = harness();
		expect((await put(cache, URL_ONE, serialize(200, { 'Cache-Control': 'max-age=0' }, 'body'))).status).toBe(204);
		advance(1);
		expect((await get(cache, URL_ONE)).status).toBe(504);
	});
});

describe('CacheObject cacheability', () => {
	test('refuses no-store, private, no-cache and Set-Cookie responses with 413', async () => {
		const { cache, storage } = harness();
		const cases: [string, Record<string, string>][] = [
			['no-store', { 'Cache-Control': 'no-store' }],
			['private', { 'Cache-Control': 'private, max-age=60' }],
			['no-cache', { 'Cache-Control': 'no-cache' }],
			['set-cookie', { 'Cache-Control': 'max-age=60', 'Set-Cookie': 'session=abc' }],
		];
		for (const [url, headers] of cases) {
			const response = await put(cache, `https://app.example/${url}`, serialize(200, headers, 'body'));
			expect(response.status).toBe(413);
			expect(await get(cache, `https://app.example/${url}`)).toMatchObject({ status: 504 });
		}
		expect([...storage.map.keys()]).toEqual([]);
	});

	test('accepts quoted directive values and mixed case', async () => {
		const { cache } = harness();
		await put(cache, URL_ONE, serialize(200, { 'cache-control': 'Public, MAX-AGE="60"' }, 'body'));
		expect((await get(cache, URL_ONE)).status).toBe(200);
	});
});

describe('CacheObject caps', () => {
	test('refuses an object over the per-object cap with 413', async () => {
		const { cache } = harness();
		cache.maxObjectBytes = 4;
		expect((await put(cache, URL_ONE, serialize(200, { 'Cache-Control': 'max-age=60' }, 'hello'))).status).toBe(413);
		expect(await get(cache, URL_ONE)).toMatchObject({ status: 504 });
		expect((await put(cache, URL_ONE, serialize(200, { 'Cache-Control': 'max-age=60' }, 'hell'))).status).toBe(204);
	});

	test('refuses a store that would exceed the total cap, and replaces within it', async () => {
		const { cache } = harness();
		cache.maxTotalBytes = 10;
		const urlTwo = 'https://app.example/two';
		expect((await put(cache, URL_ONE, serialize(200, { 'Cache-Control': 'max-age=60' }, 'aaaaaa'))).status).toBe(204);
		expect((await put(cache, urlTwo, serialize(200, { 'Cache-Control': 'max-age=60' }, 'bbbbbb'))).status).toBe(413);
		// Replacing the existing entry only counts the difference.
		expect((await put(cache, URL_ONE, serialize(200, { 'Cache-Control': 'max-age=60' }, 'aaaaa'))).status).toBe(204);
		expect((await put(cache, urlTwo, serialize(200, { 'Cache-Control': 'max-age=60' }, 'bbbb'))).status).toBe(204);
	});

	test('refuses a new key over the entry-count cap', async () => {
		const { cache } = harness();
		cache.maxEntries = 2;
		expect((await put(cache, URL_ONE, serialize(200, { 'Cache-Control': 'max-age=60' }, 'a'))).status).toBe(204);
		expect((await put(cache, 'https://app.example/two', serialize(200, { 'Cache-Control': 'max-age=60' }, 'b'))).status).toBe(204);
		expect((await put(cache, 'https://app.example/three', serialize(200, { 'Cache-Control': 'max-age=60' }, 'c'))).status).toBe(413);
	});
});

describe('CacheObject protocol edges', () => {
	test('a malformed PUT payload is a 400 and stores nothing', async () => {
		const { cache, storage } = harness();
		const response = await put(cache, URL_ONE, new TextEncoder().encode('this is not HTTP'));
		expect(response.status).toBe(400);
		expect([...storage.map.keys()]).toEqual([]);
	});

	test('an unsupported method is a 405', async () => {
		const { cache } = harness();
		const response = await cache.fetch(new Request(URL_ONE, { method: 'POST' }));
		expect(response.status).toBe(405);
		expect(response.headers.get('Allow')).toBe('GET, PUT, PURGE');
	});

	test('uses request.cf.cacheKey when workerd supplies one', async () => {
		const { cache } = harness();
		const request = new Request(URL_ONE, {
			method: 'PUT',
			body: serialize(200, { 'Cache-Control': 'max-age=60' }, 'canonical'),
		});
		Object.defineProperty(request, 'cf', { value: { cacheKey: 'https://app.example/canonical' } });
		await cache.fetch(request);

		expect((await get(cache, URL_ONE)).status).toBe(504);
		expect((await get(cache, 'https://app.example/canonical')).status).toBe(200);
	});
});

describe('default export', () => {
	test('routes every request to the single default Durable Object', async () => {
		const ids: string[] = [];
		const seen: Request[] = [];
		const env = {
			DO: {
				idFromName(name: string) {
					ids.push(name);
					return { toString: () => name } as never;
				},
				get(id: never) {
					return {
						async fetch(request: Request) {
							seen.push(request);
							return new Response(`via ${String(id)}`, { status: 201 });
						},
					};
				},
			},
		};

		const request = new Request(URL_ONE, { method: 'PURGE' });
		const response = await cacheWorker.fetch(request, env as never);
		expect(response.status).toBe(201);
		expect(await response.text()).toBe('via default');
		expect(ids).toEqual(['default']);
		expect(seen[0]?.method).toBe('PURGE');
		expect(seen[0]?.url).toBe(URL_ONE);
	});
});

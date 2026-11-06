import { afterEach, describe, expect, test } from 'bun:test';
import { KVNamespaceObject } from './kv.js';

const BASE = 'https://kv.internal';
const ORIGINAL_NOW = Date.now;
const MIB = 1024 * 1024;

/** Minimal Durable Object storage: one Map, list with prefix/limit/startAfter, sorted like workerd. */
class FakeStorage {
	map = new Map();

	async get(key) {
		return this.map.get(key);
	}

	async put(key, value) {
		this.map.set(key, value);
	}

	async delete(key) {
		this.map.delete(key);
	}

	async list(options = {}) {
		const prefix = options.prefix ?? '';
		const startAfter = options.startAfter ?? '';
		const limit = options.limit ?? 1000;
		const keys = [...this.map.keys()]
			.filter((key) => key.startsWith(prefix) && key > startAfter)
			.sort()
			.slice(0, limit);
		return new Map(keys.map((key) => [key, this.map.get(key)]));
	}
}

function makeObject() {
	const storage = new FakeStorage();
	const state = { storage };
	return { object: new KVNamespaceObject(state, {}), storage, state };
}

function url(path, params = {}) {
	const search = new URLSearchParams();
	for (const [name, value] of Object.entries(params)) search.set(name, String(value));
	const query = search.toString();
	return `${BASE}${path}${query ? `?${query}` : ''}`;
}

function putRequest(key, body = '', options = {}) {
	const params = { urlencoded: 'true' };
	if (options.ttl !== undefined) params.expiration_ttl = options.ttl;
	if (options.expiration !== undefined) params.expiration = options.expiration;
	const headers = new Headers();
	headers.set('Content-Type', options.contentType ?? 'text/plain');
	if (options.metadata !== undefined) {
		headers.set('CF-KV-Metadata', JSON.stringify(options.metadata));
	}
	return new Request(url(`/${encodeURIComponent(key)}`, params), {
		method: 'PUT',
		headers,
		body,
	});
}

function fakeNow(milliseconds) {
	Date.now = () => milliseconds;
}

afterEach(() => {
	Date.now = ORIGINAL_NOW;
});

describe('KVNamespaceObject GET/PUT/DELETE', () => {
	test('puts text and returns it with expiration and metadata headers', async () => {
		const { object } = makeObject();
		fakeNow(1_000_000_000_000);

		const put = await object.fetch(
			putRequest('greeting', 'hello', {
				ttl: 120,
				metadata: { owner: 'ada' },
			}),
		);
		expect(put.status).toBe(200);
		expect(await put.text()).toBe('');

		const get = await object.fetch(new Request(url('/greeting', { urlencoded: 'true' })));
		expect(get.status).toBe(200);
		expect(await get.text()).toBe('hello');
		expect(get.headers.get('CF-Expiration')).toBe('1000000120');
		expect(get.headers.get('CF-KV-Metadata')).toBe('{"owner":"ada"}');
	});

	test('returns 404 for a missing key, then 200 empty after delete', async () => {
		const { object } = makeObject();
		const missing = await object.fetch(new Request(url('/missing', { urlencoded: 'true' })));
		expect(missing.status).toBe(404);
		expect(await missing.text()).toBe('Not Found');

		expect((await object.fetch(putRequest('gone', 'value'))).status).toBe(200);
		const deleted = await object.fetch(
			new Request(url('/gone', { urlencoded: 'true' }), { method: 'DELETE' }),
		);
		expect(deleted.status).toBe(200);
		expect(await deleted.text()).toBe('');

		const after = await object.fetch(new Request(url('/gone', { urlencoded: 'true' })));
		expect(after.status).toBe(404);
	});

	test('omits the expiration and metadata headers when they were not set', async () => {
		const { object } = makeObject();
		await object.fetch(putRequest('plain', 'value'));
		const get = await object.fetch(new Request(url('/plain', { urlencoded: 'true' })));
		expect(get.headers.get('CF-Expiration')).toBeNull();
		expect(get.headers.get('CF-KV-Metadata')).toBeNull();
	});

	test('round-trips binary values', async () => {
		const { object } = makeObject();
		const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
		const put = await object.fetch(
			putRequest('blob', bytes, { contentType: 'application/octet-stream' }),
		);
		expect(put.status).toBe(200);

		const get = await object.fetch(new Request(url('/blob', { urlencoded: 'true' })));
		expect(get.status).toBe(200);
		expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
	});

	test('URL-decodes keys, including slashes and spaces', async () => {
		const { object } = makeObject();
		await object.fetch(putRequest('a b/c', 'nested'));
		const get = await object.fetch(new Request(url('/a%20b%2Fc', { urlencoded: 'true' })));
		expect(await get.text()).toBe('nested');
	});

	test('rejects empty keys from the wire and dot keys directly', async () => {
		const { object } = makeObject();
		const empty = await object.fetch(
			new Request(url('/', { urlencoded: 'true' }), { method: 'PUT', body: 'x' }),
		);
		expect(empty.status).toBe(400);
		expect(await empty.text()).toBe('Key names must not be empty');

		// workerd rejects "." and ".." before making the request (validateKeyName in kv.c++);
		// a URL parser would also normalise them away, so exercise the object's own guard.
		for (const key of ['.', '..']) {
			const error = await object.get(key).catch((caught) => caught);
			expect(error.status).toBe(400);
			expect(error.message).toContain(`Illegal key name "${key}"`);
		}
	});

	test('rejects unknown methods with 405', async () => {
		const { object } = makeObject();
		const response = await object.fetch(
			new Request(url('/key', { urlencoded: 'true' }), { method: 'POST', body: 'x' }),
		);
		expect(response.status).toBe(405);
	});
});

describe('expiration', () => {
	test('accepts an absolute expiration in epoch seconds', async () => {
		const { object } = makeObject();
		fakeNow(1_000_000_000_000);
		await object.fetch(putRequest('expires', 'value', { expiration: 1_000_000_100 }));
		const get = await object.fetch(new Request(url('/expires', { urlencoded: 'true' })));
		expect(get.headers.get('CF-Expiration')).toBe('1000000100');
	});

	test('expires lazily on get and removes the stored entry', async () => {
		const { object, storage } = makeObject();
		fakeNow(1_000_000_000_000);
		await object.fetch(putRequest('lazy', 'value', { ttl: 60 }));
		expect(storage.map.has('lazy')).toBe(true);

		fakeNow(1_000_000_060_000); // exactly at the expiry: already gone
		const get = await object.fetch(new Request(url('/lazy', { urlencoded: 'true' })));
		expect(get.status).toBe(404);
		expect(storage.map.has('lazy')).toBe(false);
	});

	test('skips and deletes expired keys during list', async () => {
		const { object, storage } = makeObject();
		fakeNow(1_000_000_000_000);
		await object.fetch(putRequest('dead', 'value', { ttl: 60 }));
		await object.fetch(putRequest('alive', 'value', { ttl: 600 }));
		fakeNow(1_000_000_100_000);

		const response = await object.fetch(new Request(url('/', { prefix: '' })));
		expect(await response.json()).toEqual({
			keys: [{ name: 'alive', expiration: 1000000600 }],
			list_complete: true,
			cacheStatus: null,
		});
		expect(storage.map.has('dead')).toBe(false);
	});

	test('rejects an expiration_ttl under 60 seconds, in the past, and non-numeric values', async () => {
		const { object } = makeObject();
		fakeNow(1_000_000_000_000);
		for (const ttl of [59, 0, -1]) {
			const response = await object.fetch(putRequest('bad', 'x', { ttl }));
			expect(response.status).toBe(400);
			expect(await response.text()).toContain('expiration_ttl');
		}
		const past = await object.fetch(putRequest('bad', 'x', { expiration: 999_999_999 }));
		expect(past.status).toBe(400);
		expect(await past.text()).toContain('Invalid expiration');
	});
});

describe('limits', () => {
	test('rejects a key longer than 512 UTF-8 bytes with 414', async () => {
		const { object } = makeObject();
		const key = 'k'.repeat(513);
		const response = await object.fetch(putRequest(key, 'value'));
		expect(response.status).toBe(414);
		expect(await response.text()).toBe(
			'UTF-8 encoded length of 513 exceeds key length limit of 512.',
		);
	});

	test('rejects a value larger than 25 MiB with 413', async () => {
		const { object } = makeObject();
		const response = await object.fetch(
			putRequest('big', new Uint8Array(25 * MIB + 1), { contentType: 'application/octet-stream' }),
		);
		expect(response.status).toBe(413);
		expect(await response.text()).toBe('Value length of 26214401 exceeds limit of 26214400.');
	});

	test('rejects metadata larger than 1 KiB with 413', async () => {
		const { object } = makeObject();
		const headers = new Headers({ 'Content-Type': 'text/plain' });
		headers.set('CF-KV-Metadata', JSON.stringify('m'.repeat(1024)));
		const response = await object.fetch(
			new Request(url('/meta', { urlencoded: 'true' }), { method: 'PUT', headers, body: 'x' }),
		);
		expect(response.status).toBe(413);
		expect(await response.text()).toContain('Metadata length of 1026 exceeds limit of 1024.');
	});

	test('rejects a list limit above 1000 and below 1 with 400', async () => {
		const { object } = makeObject();
		for (const limit of [1001, 0]) {
			const response = await object.fetch(new Request(url('/', { key_count_limit: limit })));
			expect(response.status).toBe(400);
			expect(await response.text()).toContain('Invalid key_count_limit');
		}
	});
});

describe('list', () => {
	test('returns keys in order with metadata as a JSON string', async () => {
		const { object } = makeObject();
		await object.fetch(putRequest('a', '1', { metadata: { n: 1 } }));
		await object.fetch(putRequest('b', '2'));

		const response = await object.fetch(new Request(url('/', { prefix: '' })));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			keys: [{ name: 'a', metadata: '{"n":1}' }, { name: 'b' }],
			list_complete: true,
			cacheStatus: null,
		});
	});

	test('filters by prefix', async () => {
		const { object } = makeObject();
		await object.fetch(putRequest('a1', 'x'));
		await object.fetch(putRequest('a2', 'x'));
		await object.fetch(putRequest('b1', 'x'));

		const response = await object.fetch(new Request(url('/', { prefix: 'a' })));
		expect((await response.json()).keys.map((key) => key.name)).toEqual(['a1', 'a2']);
	});

	test('paginates with a cursor equal to the last returned key', async () => {
		const { object } = makeObject();
		for (const key of ['a1', 'a2', 'a3']) await object.fetch(putRequest(key, 'x'));

		const first = await object.fetch(new Request(url('/', { key_count_limit: 2 })));
		expect(await first.json()).toEqual({
			keys: [{ name: 'a1' }, { name: 'a2' }],
			list_complete: false,
			cursor: 'a2',
			cacheStatus: null,
		});

		const second = await object.fetch(
			new Request(url('/', { key_count_limit: 2, cursor: 'a2' })),
		);
		expect(await second.json()).toEqual({
			keys: [{ name: 'a3' }],
			list_complete: true,
			cacheStatus: null,
		});
	});
});

describe('bulk get', () => {
	async function bulk(object, body) {
		return object.fetch(
			new Request(url('/bulk/get'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			}),
		);
	}

	test('returns text values, missing keys as null, and metadata when requested', async () => {
		const { object } = makeObject();
		await object.fetch(putRequest('one', 'first', { metadata: { a: 1 } }));
		await object.fetch(putRequest('two', 'second'));

		const response = await bulk(object, { keys: ['one', 'two', 'missing'], type: 'text' });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ one: 'first', two: 'second', missing: null });

		const withMetadata = await bulk(object, { keys: ['one', 'missing'], withMetadata: true });
		expect(await withMetadata.json()).toEqual({
			one: { value: 'first', metadata: { a: 1 } },
			missing: null,
		});
	});

	test('parses JSON values and rejects a non-JSON value with 400', async () => {
		const { object } = makeObject();
		await object.fetch(putRequest('json', JSON.stringify({ ok: true })));
		await object.fetch(putRequest('text', 'not json'));

		const response = await bulk(object, { keys: ['json'], type: 'json' });
		expect(await response.json()).toEqual({ json: { ok: true } });

		const failed = await bulk(object, { keys: ['text'], type: 'json' });
		expect(failed.status).toBe(400);
		expect(await failed.text()).toBe(
			'At least one of the requested keys corresponds to a non-json value',
		);
	});

	test('treats a "__proto__" key as an ordinary entry', async () => {
		const { object } = makeObject();
		await object.fetch(putRequest('__proto__', 'value'));
		const response = await bulk(object, { keys: ['__proto__'] });
		expect(await response.json()).toEqual({ ['__proto__']: 'value' });
	});

	test('rejects bad types, empty lists, too many keys and a bad body', async () => {
		const { object } = makeObject();

		const type = await bulk(object, { keys: ['a'], type: 'stream' });
		expect(type.status).toBe(400);
		expect(await type.text()).toBe('"stream" is not a valid type. Use "json" or "text"');

		const empty = await bulk(object, { keys: [] });
		expect(empty.status).toBe(400);

		const many = await bulk(object, { keys: Array.from({ length: 101 }, (_, i) => `k${i}`) });
		expect(many.status).toBe(400);
		expect(await many.text()).toBe('You can request a maximum of 100 keys');

		const invalid = await object.fetch(
			new Request(url('/bulk/get'), { method: 'POST', body: 'not json' }),
		);
		expect(invalid.status).toBe(400);
	});
});

describe('default export', () => {
	test('routes every request to the "default" Durable Object', async () => {
		const seen = [];
		const env = {
			DO: {
				idFromName(name) {
					return { name };
				},
				get(id) {
					return {
						async fetch(request) {
							seen.push({ id, url: request.url });
							return new Response('from-object');
						},
					};
				},
			},
		};

		const { default: worker } = await import('./kv.js');
		const response = await worker.fetch(new Request(url('/hello', { urlencoded: 'true' })), env);
		expect(await response.text()).toBe('from-object');
		expect(seen).toHaveLength(1);
		expect(seen[0].id).toEqual({ name: 'default' });
		expect(seen[0].url).toBe(url('/hello', { urlencoded: 'true' }));
	});
});

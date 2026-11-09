import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	LocalObjectStore,
	R2ObjectStore,
	S3ObjectStore,
	bodyToAsyncIterable,
	storageKindForDb,
} from './object-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-objects-'));
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function* bytes(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
	yield* chunks;
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of bodyToAsyncIterable(body)) {
		chunks.push(chunk);
		total += chunk.byteLength;
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

interface S3Call {
	method: string;
	url: string;
	headers: Headers;
	body: Uint8Array | null;
}

function fakeS3(options: { bucket?: string; headStatus?: number } = {}) {
	const bucket = options.bucket ?? 'yoal';
	const objects = new Map<string, Uint8Array>();
	const calls: S3Call[] = [];

	const keyFor = (url: URL): string => {
		const path = decodeURIComponent(url.pathname);
		if (path === `/${bucket}` || path === `/${bucket}/` || path === '' || path === '/') return '';
		if (path.startsWith(`/${bucket}/`)) return path.slice(bucket.length + 2);
		return path.replace(/^\/+/, '');
	};

	const fetchImpl = (async (input: Request | string | URL) => {
		const request = input instanceof Request ? input : new Request(String(input));
		const url = new URL(request.url);
		const key = keyFor(url);
		const body = request.method === 'PUT' ? new Uint8Array(await request.arrayBuffer()) : null;
		calls.push({ method: request.method, url: request.url, headers: new Headers(request.headers), body });

		if (request.method === 'HEAD') {
			if (options.headStatus && !key) return new Response(null, { status: options.headStatus });
			if (!key) return new Response(null, { status: 200 });
			const data = objects.get(key);
			return data
				? new Response(null, { status: 200, headers: { 'content-length': String(data.byteLength) } })
				: new Response(null, { status: 404 });
		}

		if (request.method === 'PUT') {
			objects.set(key, body ?? new Uint8Array());
			return new Response(null, { status: 200 });
		}

		if (request.method === 'DELETE') {
			objects.delete(key);
			return new Response(null, { status: 204 });
		}

		if (request.method === 'GET') {
			if (url.searchParams.has('list-type')) {
				const prefix = url.searchParams.get('prefix') ?? '';
				const contents = [...objects.entries()]
					.filter(([name]) => name.startsWith(prefix))
					.sort(([a], [b]) => a.localeCompare(b))
					.map(
						([name, data]) =>
							`<Contents><Key>${escapeXml(name)}</Key><LastModified>2026-01-02T03:04:05.000Z</LastModified><Size>${data.byteLength}</Size></Contents>`,
					)
					.join('');
				return new Response(
					`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
					{ headers: { 'content-type': 'application/xml' } },
				);
			}
			const data = objects.get(key);
			if (!data) return new Response('missing', { status: 404 });
			return new Response(data, { headers: { 'content-length': String(data.byteLength) } });
		}

		return new Response(null, { status: 405 });
	}) as typeof fetch;

	return { fetchImpl, calls, objects };
}

function escapeXml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function s3(fake: ReturnType<typeof fakeS3>, overrides: Partial<ConstructorParameters<typeof S3ObjectStore>[0]> = {}) {
	return new S3ObjectStore({
		endpoint: 'http://minio.test:9000',
		bucket: 'yoal',
		region: 'us-east-1',
		forcePathStyle: true,
		accessKeyId: 'AKIAEXAMPLE',
		secretAccessKey: 'not-a-real-secret',
		fetch: fake.fetchImpl,
		...overrides,
	});
}

describe('LocalObjectStore', () => {
	test('keeps the buffered put/get API source-compatible', async () => {
		const data = new TextEncoder().encode('hello objects');
		await store.put('releases/a.zip', data, 'application/zip');
		expect(await store.get('releases/a.zip')).toEqual(data);
		expect(await store.exists('releases/a.zip')).toBe(true);
		expect(await store.size('releases/a.zip')).toBe(data.byteLength);

		const url = new URL(await store.presignPut('releases/a.zip', 60));
		expect(url.searchParams.get('sig')).toBeTruthy();
		expect(store.verify('PUT', 'releases/a.zip', Number(url.searchParams.get('exp')), url.searchParams.get('sig')!)).toBe(
			true,
		);
		expect(store.verify('PUT', 'releases/a.zip', Number(url.searchParams.get('exp')), 'wrong')).toBe(false);

		await store.delete('releases/a.zip');
		expect(await store.exists('releases/a.zip')).toBe(false);
		expect(await store.size('releases/a.zip')).toBeNull();
	});

	test('streams a 1 GiB logical object without buffering it whole', async () => {
		const gib = 1024 * 1024 * 1024;
		const chunkSize = 4 * 1024 * 1024;
		const large = new LocalObjectStore(join(dir, 'large'), 'https://control.test', 'object-secret-123');
		async function* generator() {
			for (let offset = 0; offset < gib; offset += chunkSize) {
				const size = Math.min(chunkSize, gib - offset);
				const chunk = new Uint8Array(size);
				chunk[0] = (offset / chunkSize) & 0xff;
				chunk[size - 1] = offset & 0xff;
				yield chunk;
			}
		}

		const gc = (globalThis as unknown as { Bun?: { gc?: (force?: boolean) => void } }).Bun?.gc;
		gc?.(true);
		const before = process.memoryUsage().arrayBuffers;
		await large.putStream('large.bin', generator(), 'application/octet-stream', gib);
		expect(statSync(join(dir, 'large', 'large.bin')).size).toBe(gib);

		const stream = await large.getStream('large.bin');
		expect(stream.size).toBe(gib);
		let read = 0;
		let maxChunk = 0;
		for await (const chunk of bodyToAsyncIterable(stream.body)) {
			read += chunk.byteLength;
			maxChunk = Math.max(maxChunk, chunk.byteLength);
		}
		expect(read).toBe(gib);
		// A full-body buffer would arrive as one huge chunk (or produce a ~1 GiB arrayBuffers jump).
		expect(maxChunk).toBeLessThan(gib / 8);

		gc?.(true);
		if (gc) {
			const after = process.memoryUsage().arrayBuffers;
			expect(after - before).toBeLessThan(512 * 1024 * 1024);
		}
	}, 120_000);

	test('accepts a web ReadableStream and rejects a truncated declared size', async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2]));
				controller.enqueue(new Uint8Array([3]));
				controller.close();
			},
		});
		await store.putStream('streams/web.bin', body, 'application/octet-stream', 3);
		expect(await collect((await store.getStream('streams/web.bin')).body)).toEqual(new Uint8Array([1, 2, 3]));

		await expect(store.putStream('streams/short.bin', bytes(new Uint8Array([1])), undefined, 2)).rejects.toThrow(
			/size mismatch/,
		);
		expect(await store.exists('streams/short.bin')).toBe(false);
	});

	test('rejects traversal keys and reports missing objects', async () => {
		await expect(store.put('../escape.bin', new Uint8Array([1]))).rejects.toThrow(/Invalid object key/);
		await expect(store.putStream('../escape.bin', bytes(new Uint8Array([1])))).rejects.toThrow(/Invalid object key/);
		await expect(store.getStream('../escape.bin')).rejects.toThrow(/Invalid object key/);

		await expect(store.get('missing.bin')).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(store.getStream('missing.bin')).rejects.toMatchObject({ code: 'ENOENT' });
	});

	test('lists objects and refuses a prefix outside the root', async () => {
		const local = new LocalObjectStore(join(dir, 'listing'), 'https://control.test', 'secret');
		await local.put('releases/one.zip', new Uint8Array([1, 2]));
		await local.put('releases/two.zip', new Uint8Array([3]));
		const listed: string[] = [];
		for await (const object of local.list('releases/')) listed.push(object.key);
		expect(listed).toEqual(['releases/one.zip', 'releases/two.zip']);

		const iterate = async () => {
			for await (const _object of local.list('../')) void _object;
		};
		await expect(iterate()).rejects.toThrow(/Invalid object prefix/);
	});

	test('testConnection probes head, put, list and delete', async () => {
		const result = await store.testConnection?.();
		expect(result?.ok).toBe(true);
		expect(result?.checks).toEqual({ head: true, put: true, list: true, delete: true });
	});
});

describe('S3ObjectStore', () => {
	test('streams path-style PUT/GET requests with content type and length', async () => {
		const fake = fakeS3();
		const client = s3(fake);
		const data = new Uint8Array([1, 2, 3, 4, 5]);
		await client.putStream('uploads/a b.bin', bytes(data.subarray(0, 3), data.subarray(3)), 'application/octet-stream', data.byteLength);

		const put = fake.calls.find((call) => call.method === 'PUT')!;
		expect(new URL(put.url).pathname).toBe('/yoal/uploads/a%20b.bin');
		expect(put.headers.get('content-type')).toBe('application/octet-stream');
		expect(put.headers.get('content-length')).toBe('5');
		expect(put.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');
		expect(put.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
		expect(put.body).toEqual(data);

		const stream = await client.getStream('uploads/a b.bin');
		expect(stream.size).toBe(data.byteLength);
		expect(await collect(stream.body)).toEqual(data);
	});

	test('supports virtual-hosted paths when forcePathStyle is off', async () => {
		const fake = fakeS3();
		const client = s3(fake, { endpoint: 'https://s3.example.test', forcePathStyle: false });
		await client.put('releases/x.zip', new Uint8Array([9, 9]), 'application/zip');
		const put = fake.calls.find((call) => call.method === 'PUT')!;
		const url = new URL(put.url);
		expect(url.host).toBe('yoal.s3.example.test');
		expect(url.pathname).toBe('/releases/x.zip');
		expect(put.headers.get('content-type')).toBe('application/zip');

		expect(await client.get('releases/x.zip')).toEqual(new Uint8Array([9, 9]));
		expect(await client.size('releases/x.zip')).toBe(2);
		expect(await client.exists('releases/x.zip')).toBe(true);
		await client.delete('releases/x.zip');
		expect(await client.exists('releases/x.zip')).toBe(false);
	});

	test('keeps the R2 config path working as an S3 endpoint', async () => {
		const fake = fakeS3({ bucket: 'releases' });
		const r2 = new R2ObjectStore({
			accountId: 'acct123',
			bucket: 'releases',
			accessKeyId: 'AKIAEXAMPLE',
			secretAccessKey: 'not-a-real-secret',
			fetch: fake.fetchImpl,
		});
		await r2.put('a.zip', new Uint8Array([7]));
		const put = fake.calls.find((call) => call.method === 'PUT')!;
		const url = new URL(put.url);
		expect(url.host).toBe('acct123.r2.cloudflarestorage.com');
		expect(url.pathname).toBe('/releases/a.zip');
		expect(r2.kind).toBe('s3');
	});

	test('reports missing objects on both read paths', async () => {
		const client = s3(fakeS3());
		await expect(client.get('missing.bin')).rejects.toThrow(/S3 GET missing\.bin failed: 404/);
		await expect(client.getStream('missing.bin')).rejects.toThrow(/S3 GET missing\.bin failed: 404/);
	});

	test('presigns short-lived GET/PUT URLs without leaking the secret', async () => {
		const client = s3(fakeS3());
		const url = new URL(await client.presignGet('releases/x.zip', 60));
		expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
		expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
		expect(url.toString()).not.toContain('not-a-real-secret');
	});

	test('testConnection probes head, put, list and delete', async () => {
		const fake = fakeS3();
		const result = await s3(fake).testConnection();
		expect(result.ok).toBe(true);
		expect(result.checks).toEqual({ head: true, put: true, list: true, delete: true });
		expect(fake.calls.map((call) => call.method)).toEqual(['HEAD', 'GET', 'PUT', 'GET', 'DELETE']);
	});

	test('testConnection reports a clear failure on bad credentials', async () => {
		const result = await s3(fakeS3({ headStatus: 403 })).testConnection();
		expect(result.ok).toBe(false);
		expect(result.checks.head).toBe(false);
		expect(result.error).toContain('403');
		expect(JSON.stringify(result)).not.toContain('not-a-real-secret');
	});
});

describe('storage kind compatibility', () => {
	test('maps the new s3 kind onto the legacy r2 database enum', () => {
		expect(storageKindForDb('s3')).toBe('r2');
		expect(storageKindForDb('local')).toBe('local');
	});
});

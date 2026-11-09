import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StorageAdmin, StorageReplicationDesired, WorkloadObjectStorage } from '@yoal/contracts';
import { StorageApiError, type StorageTarget } from './storage-admin.ts';
import {
	S3ReplicaStore,
	StorageReplicator,
	addressableKey,
	compareKeys,
	needsCopy,
	type ReplicaHead,
	type ReplicaObject,
	type ReplicaRead,
	type ReplicaStore,
	type S3ReplicaStoreOptions,
} from './storage-replicator.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-replicator-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Stored {
	body: Uint8Array;
	etag: string;
	lastModified: number;
	headers: Record<string, string>;
}

/** In-memory S3 side: byte-ordered listings with small pages, multipart ETags like S3. */
class MemoryStore implements ReplicaStore {
	readonly buckets = new Map<string, Map<string, Stored>>();
	readonly calls: string[] = [];
	readonly listCalls: Array<{ bucket: string; startAfter: string | null }> = [];
	failList: string | null = null;
	pageSize = 2;
	clock = 1_000;
	private uploads = new Map<string, { bucket: string; key: string; headers: Record<string, string>; parts: Map<number, Uint8Array> }>();

	bucket(name: string): Map<string, Stored> {
		let bucket = this.buckets.get(name);
		if (!bucket) {
			bucket = new Map();
			this.buckets.set(name, bucket);
		}
		return bucket;
	}

	put(bucket: string, key: string, text: string | Uint8Array, headers: Record<string, string> = {}, lastModified = this.clock++) {
		const body = typeof text === 'string' ? new TextEncoder().encode(text) : text;
		this.bucket(bucket).set(key, { body, etag: md5(body), lastModified, headers });
	}

	text(bucket: string, key: string): string | undefined {
		const object = this.buckets.get(bucket)?.get(key);
		return object ? new TextDecoder().decode(object.body) : undefined;
	}

	async listObjects(bucket: string, options: { startAfter?: string | null; token?: string | null }) {
		if (this.failList === bucket) throw new StorageApiError('GET /x -> 500 InternalError', 500, 'InternalError');
		if (!options.token) this.listCalls.push({ bucket, startAfter: options.startAfter ?? null });
		const keys = [...(this.buckets.get(bucket)?.keys() ?? [])].sort(compareKeys);
		const after = options.token ?? options.startAfter ?? null;
		const from = after === null ? keys : keys.filter((key) => compareKeys(key, after) > 0);
		const page = from.slice(0, this.pageSize);
		const objects: ReplicaObject[] = page.map((key) => {
			const stored = this.buckets.get(bucket)!.get(key)!;
			return { key, size: stored.body.length, etag: stored.etag, lastModified: stored.lastModified };
		});
		return { objects, next: from.length > page.length ? page[page.length - 1]! : null };
	}

	async headObject(bucket: string, key: string): Promise<ReplicaHead | null> {
		const stored = this.buckets.get(bucket)?.get(key);
		return stored ? { size: stored.body.length, etag: stored.etag, headers: { ...stored.headers } } : null;
	}

	async getObject(bucket: string, key: string, options: { range?: [number, number]; ifMatch?: string | null } = {}): Promise<ReplicaRead | null> {
		const stored = this.buckets.get(bucket)?.get(key);
		if (!stored) return null;
		if (options.ifMatch && options.ifMatch !== stored.etag) throw new StorageApiError('412 PreconditionFailed', 412, 'PreconditionFailed');
		this.calls.push(`get:${key}${options.range ? `:${options.range[0]}-${options.range[1]}` : ''}`);
		const body = options.range ? stored.body.slice(options.range[0], options.range[1] + 1) : stored.body;
		return { body, etag: stored.etag, headers: { ...stored.headers } };
	}

	async putObject(bucket: string, key: string, body: Uint8Array, headers: Record<string, string>) {
		this.calls.push(`put:${key}`);
		this.put(bucket, key, body, headers);
	}

	async createMultipart(bucket: string, key: string, headers: Record<string, string>) {
		const id = `up-${this.uploads.size + 1}`;
		this.uploads.set(id, { bucket, key, headers, parts: new Map() });
		this.calls.push(`mpu:${key}`);
		return id;
	}

	async uploadPart(_bucket: string, _key: string, uploadId: string, partNumber: number, body: Uint8Array) {
		this.uploads.get(uploadId)!.parts.set(partNumber, body);
		this.calls.push(`part:${partNumber}`);
		return `"${md5(body)}"`;
	}

	async completeMultipart(_bucket: string, _key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>) {
		const upload = this.uploads.get(uploadId)!;
		const chunks = parts.map((part) => upload.parts.get(part.partNumber)!);
		const body = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.length;
		}
		this.bucket(upload.bucket).set(upload.key, {
			body,
			etag: `${md5(body)}-${parts.length}`,
			lastModified: this.clock++,
			headers: upload.headers,
		});
		this.uploads.delete(uploadId);
		this.calls.push(`complete:${upload.key}`);
	}

	async abortMultipart(_bucket: string, _key: string, uploadId: string) {
		this.uploads.delete(uploadId);
		this.calls.push('abort');
	}

	async deleteObjects(bucket: string, keys: string[]) {
		this.calls.push(`delete:${keys.join(',')}`);
		for (const key of keys) this.buckets.get(bucket)?.delete(key);
	}
}

function md5(body: Uint8Array): string {
	return createHash('md5').update(body).digest('hex');
}

const admin = (replication: Record<string, string>): StorageAdmin => ({
	rootAccessKeyId: 'SKRLOCALROOT',
	rootSecretAccessKey: 'local-root-secret',
	port: 19001,
	keysVersion: 'a'.repeat(64),
	users: {},
	replication,
});

const link = (overrides: Partial<StorageReplicationDesired> = {}): StorageReplicationDesired => ({
	id: 'srp_1',
	direction: 'push',
	peerId: 'st_peer',
	endpoint: 'http://10.88.1.3:8080',
	host: 's3-peer.storage.internal',
	accessKeyId: 'SKFLINKKEY',
	buckets: ['media'],
	intervalSeconds: 900,
	deletes: true,
	...overrides,
});

function targetWith(links: StorageReplicationDesired[], secrets: Record<string, string> = { srp_1: 'link-secret' }): StorageTarget {
	const desired: WorkloadObjectStorage = {
		engine: 'rustfs',
		version: '1.0.4',
		buckets: [],
		users: [],
		deleteBuckets: [],
		keysVersion: 'a'.repeat(64),
		replication: links,
	};
	return { id: 'st_local', activationVersion: 'v1', port: 19001, status: 'running', admin: admin(secrets), desired };
}

function setup(options: { links?: StorageReplicationDesired[]; secrets?: Record<string, string>; name: string; partBytes?: number }) {
	const local = new MemoryStore();
	const peer = new MemoryStore();
	let clock = Date.parse('2026-11-07T10:00:00Z');
	let target = targetWith(options.links ?? [link()], options.secrets);
	const built: S3ReplicaStoreOptions[] = [];
	const statePath = join(dir, `${options.name}.json`);
	const replicator = new StorageReplicator({
		source: { storageTargets: () => [target] },
		statePath,
		storeFor: (store) => {
			built.push(store);
			return store.host ? peer : local;
		},
		now: () => clock,
		...(options.partBytes ? { partBytes: options.partBytes } : {}),
	});
	return {
		local,
		peer,
		replicator,
		built,
		statePath,
		advance: (ms: number) => (clock += ms),
		now: () => clock,
		setTarget: (next: StorageTarget) => (target = next),
	};
}

describe('storage replicator', () => {
	test('push: copies missing and changed objects, skips equal ones, mirrors deletes', async () => {
		const ctx = setup({ name: 'push' });
		ctx.local.put('media', 'a.txt', 'alpha', { 'content-type': 'text/plain', 'x-amz-meta-owner': 'kieran' });
		ctx.local.put('media', 'b.txt', 'bravo');
		ctx.local.put('media', 'c.txt', 'charlie-v2');
		ctx.peer.put('media', 'b.txt', 'bravo');
		ctx.peer.put('media', 'c.txt', 'charlie');
		ctx.peer.put('media', 'gone.txt', 'deleted on the source');

		await ctx.replicator.tick();

		expect(ctx.peer.text('media', 'a.txt')).toBe('alpha');
		expect(ctx.peer.buckets.get('media')!.get('a.txt')!.headers).toEqual({ 'content-type': 'text/plain', 'x-amz-meta-owner': 'kieran' });
		expect(ctx.peer.text('media', 'c.txt')).toBe('charlie-v2');
		expect(ctx.peer.text('media', 'gone.txt')).toBeUndefined();
		expect(ctx.peer.calls).not.toContain('put:b.txt');
		// The peer is reached through its gateway, signed for its internal host, with the link key.
		expect(ctx.built).toContainEqual({
			endpoint: 'http://10.88.1.3:8080',
			host: 's3-peer.storage.internal',
			accessKeyId: 'SKFLINKKEY',
			secretAccessKey: 'link-secret',
		});
		expect(ctx.built).toContainEqual({
			endpoint: 'http://127.0.0.1:19001',
			accessKeyId: 'SKRLOCALROOT',
			secretAccessKey: 'local-root-secret',
		});

		const [report] = ctx.replicator.pendingReports();
		expect(report).toMatchObject({
			id: 'srp_1',
			status: 'in-sync',
			lastSyncAt: '2026-11-07T10:00:00.000Z',
			pending: 0,
			copiedObjects: 2,
			copiedBytes: 'alpha'.length + 'charlie-v2'.length,
			error: null,
		});
		expect(report!.buckets).toEqual([
			{ name: 'media', status: 'in-sync', pending: 0, lastSyncAt: '2026-11-07T10:00:00.000Z', error: null },
		]);
		ctx.replicator.acknowledgeReports([report!]);
		expect(ctx.replicator.pendingReports()).toEqual([]);

		// Nothing runs again until the interval is over; then an unchanged bucket copies nothing.
		ctx.peer.calls.length = 0;
		ctx.advance(60_000);
		await ctx.replicator.tick();
		expect(ctx.peer.calls).toEqual([]);
		ctx.advance(900_000);
		await ctx.replicator.tick();
		expect(ctx.peer.calls.filter((call) => call.startsWith('put:'))).toEqual([]);
		expect(ctx.replicator.pendingReports()[0]).toMatchObject({ copiedObjects: 0, lastSyncAt: '2026-11-07T10:16:00.000Z' });
	});

	test('a failed source listing never deletes from the target', async () => {
		const ctx = setup({ name: 'list-fail' });
		ctx.peer.put('media', 'keep.txt', 'still here');
		ctx.local.failList = 'media';
		await ctx.replicator.tick();
		expect(ctx.peer.text('media', 'keep.txt')).toBe('still here');
		const [report] = ctx.replicator.pendingReports();
		expect(report).toMatchObject({ status: 'error', lastSyncAt: null });
		expect(report!.error).toContain('listing the source');
		expect(report!.buckets[0]).toMatchObject({ name: 'media', status: 'error' });

		// Retried after a minute, not at the next tick.
		ctx.local.failList = null;
		ctx.advance(15_000);
		await ctx.replicator.tick();
		expect(ctx.peer.text('media', 'keep.txt')).toBe('still here');
		ctx.advance(60_000);
		await ctx.replicator.tick();
		expect(ctx.peer.text('media', 'keep.txt')).toBeUndefined();
		expect(ctx.replicator.pendingReports()[0]).toMatchObject({ status: 'in-sync', error: null });
	});

	test('large objects go multipart with ranged reads pinned to the source ETag', async () => {
		const ctx = setup({ name: 'multipart', partBytes: 5 * 1024 * 1024 });
		const big = new Uint8Array(11 * 1024 * 1024);
		for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
		ctx.local.put('media', 'video.mp4', big, { 'content-type': 'video/mp4' });
		await ctx.replicator.tick();
		expect(ctx.peer.calls).toEqual(['mpu:video.mp4', 'part:1', 'part:2', 'part:3', 'complete:video.mp4']);
		expect(ctx.local.calls).toEqual([
			'get:video.mp4:0-5242879',
			'get:video.mp4:5242880-10485759',
			'get:video.mp4:10485760-11534335',
		]);
		const copy = ctx.peer.buckets.get('media')!.get('video.mp4')!;
		expect(md5(copy.body)).toBe(md5(big));
		expect(copy.headers).toEqual({ 'content-type': 'video/mp4' });
		// The copy has a multipart ETag, so the next pass compares size and time instead.
		ctx.peer.calls.length = 0;
		ctx.advance(901_000);
		await ctx.replicator.tick();
		expect(ctx.peer.calls).toEqual([]);
	});

	test('a source change during a multipart copy aborts the upload and reports the object', async () => {
		const ctx = setup({ name: 'multipart-race', partBytes: 5 * 1024 * 1024 });
		ctx.local.put('media', 'big.bin', new Uint8Array(6 * 1024 * 1024));
		const original = ctx.local.getObject.bind(ctx.local);
		ctx.local.getObject = async (bucket, key, options) => {
			if (options?.range?.[0] === 0) ctx.local.put('media', 'big.bin', new Uint8Array(7 * 1024 * 1024).fill(1));
			return original(bucket, key, options);
		};
		await ctx.replicator.tick();
		expect(ctx.peer.calls).toContain('abort');
		expect(ctx.peer.buckets.get('media')?.has('big.bin') ?? false).toBe(false);
		const [report] = ctx.replicator.pendingReports();
		expect(report).toMatchObject({ status: 'error', pending: 1 });
		expect(report!.buckets[0]!.error).toContain('big.bin');
	});

	test('pull: the edge copy reads the worker source through its gateway', async () => {
		const ctx = setup({ name: 'pull', links: [link({ direction: 'pull' })] });
		ctx.peer.put('media', 'from-worker.txt', 'hello');
		await ctx.replicator.tick();
		expect(ctx.local.text('media', 'from-worker.txt')).toBe('hello');
		expect(ctx.peer.calls).toEqual(['get:from-worker.txt']);
	});

	test('resumes a checkpointed pass after the last handled key, keeping the previous sync time', async () => {
		const ctx = setup({ name: 'resume', links: [link({ buckets: ['aaa', 'media'] })] });
		writeFileSync(
			ctx.statePath,
			JSON.stringify({
				version: 1,
				links: {
					srp_1: {
						lastSyncAt: '2026-11-06T10:00:00.000Z',
						buckets: { aaa: '2026-11-07T09:55:00.000Z' },
						pass: {
							startedAt: '2026-11-07T09:55:00.000Z',
							done: { aaa: { name: 'aaa', status: 'in-sync', pending: 0, lastSyncAt: '2026-11-07T09:55:00.000Z', error: null } },
							bucket: 'media',
							afterKey: 'k2',
						},
					},
				},
			}),
		);
		for (const key of ['k1', 'k2', 'k3', 'k4']) ctx.local.put('media', key, key);
		ctx.local.put('aaa', 'not-listed', 'x');
		await ctx.replicator.tick();
		expect(ctx.local.listCalls).toEqual([{ bucket: 'media', startAfter: 'k2' }]);
		expect(ctx.peer.text('media', 'k3')).toBe('k3');
		expect(ctx.peer.text('media', 'k1')).toBeUndefined();
		const [report] = ctx.replicator.pendingReports();
		// The pass that finished started before the restart: that is when the copy was last whole.
		expect(report).toMatchObject({ status: 'in-sync', lastSyncAt: '2026-11-07T09:55:00.000Z', copiedObjects: 2 });
		const saved = JSON.parse(readFileSync(ctx.statePath, 'utf8'));
		expect(saved.links.srp_1.pass).toBeNull();
		expect(saved.links.srp_1.lastSyncAt).toBe('2026-11-07T09:55:00.000Z');
	});

	test('a link without its secret is reported as waiting; a removed link drops its checkpoint', async () => {
		const ctx = setup({ name: 'waiting', secrets: {} });
		await ctx.replicator.tick();
		expect(ctx.replicator.pendingReports()).toMatchObject([{ id: 'srp_1', status: 'error', error: expect.stringContaining('Waiting') }]);
		ctx.setTarget(targetWith([link()]));
		ctx.advance(1000);
		await ctx.replicator.tick();
		expect(JSON.parse(readFileSync(ctx.statePath, 'utf8')).links.srp_1).toBeTruthy();
		ctx.setTarget(targetWith([]));
		await ctx.replicator.tick();
		expect(JSON.parse(readFileSync(ctx.statePath, 'utf8')).links).toEqual({});
		expect(ctx.replicator.pendingReports()).toEqual([]);
	});

	test('error text never carries a secret', async () => {
		const ctx = setup({ name: 'scrub' });
		ctx.local.put('media', 'x.txt', 'x');
		ctx.peer.putObject = async () => {
			throw new Error('upstream echoed link-secret and local-root-secret');
		};
		await ctx.replicator.tick();
		const text = JSON.stringify(ctx.replicator.pendingReports());
		expect(text).not.toContain('link-secret');
		expect(text).not.toContain('local-root-secret');
	});
});

describe('comparison', () => {
	const object = (overrides: Partial<ReplicaObject> = {}): ReplicaObject => ({
		key: 'k',
		size: 10,
		etag: 'aaaa',
		lastModified: 1000,
		...overrides,
	});

	test('copy when missing, resized, or a single-part ETag differs', () => {
		expect(needsCopy(object(), undefined)).toBe(true);
		expect(needsCopy(object({ size: 11 }), object())).toBe(true);
		expect(needsCopy(object({ etag: 'bbbb' }), object({ lastModified: 9999 }))).toBe(true);
		expect(needsCopy(object({ lastModified: 5000 }), object())).toBe(false);
	});

	test('a multipart ETag on either side falls back to the modification time', () => {
		expect(needsCopy(object({ etag: 'aaaa-3', lastModified: 500 }), object({ lastModified: 1000 }))).toBe(false);
		expect(needsCopy(object({ etag: 'aaaa', lastModified: 2000 }), object({ etag: 'cccc-2', lastModified: 1000 }))).toBe(true);
	});

	test('keys order by UTF-8 bytes, as S3 lists them', () => {
		expect(compareKeys('￿', '\u{1F600}')).toBeLessThan(0);
		expect('￿' < '\u{1F600}').toBe(false);
		expect(compareKeys('a', 'b')).toBeLessThan(0);
	});

	test('dot segments are not addressable path-style', () => {
		expect(addressableKey('a/./b')).toBe(false);
		expect(addressableKey('../x')).toBe(false);
		expect(addressableKey('a.b/c..d')).toBe(true);
	});
});

describe('S3ReplicaStore', () => {
	test('signs for the internal host and sends it as Host to the gateway', async () => {
		const seen: Array<{ url: string; host: string | null; auth: string | null; sha: string | null }> = [];
		const store = new S3ReplicaStore({
			endpoint: 'http://10.88.1.3:8080',
			host: 's3-peer.storage.internal',
			accessKeyId: 'SKFLINKKEY',
			secretAccessKey: 'link-secret',
			fetch: async (url, init) => {
				const headers = new Headers(init.headers);
				seen.push({ url, host: headers.get('host'), auth: headers.get('authorization'), sha: headers.get('x-amz-content-sha256') });
				return new Response(
					'<ListBucketResult><Contents><Key>a &amp; b.txt</Key><Size>3</Size><ETag>&quot;abc&quot;</ETag><LastModified>2026-11-07T10:00:00.000Z</LastModified></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken></ListBucketResult>',
					{ status: 200 },
				);
			},
		});
		const page = await store.listObjects('media', { startAfter: 'k0' });
		expect(page).toEqual({
			objects: [{ key: 'a & b.txt', size: 3, etag: 'abc', lastModified: Date.parse('2026-11-07T10:00:00.000Z') }],
			next: 'tok',
		});
		expect(seen[0]!.url).toStartWith('http://10.88.1.3:8080/media?');
		expect(seen[0]!.url).toContain('start-after=k0');
		expect(seen[0]!.host).toBe('s3-peer.storage.internal');
		expect(seen[0]!.auth).toContain('Credential=SKFLINKKEY/');
		expect(seen[0]!.auth).not.toContain('link-secret');
	});

	test('a part upload sends a signed payload hash and returns the ETag', async () => {
		let sha: string | null = null;
		let url = '';
		const store = new S3ReplicaStore({
			endpoint: 'http://127.0.0.1:19001',
			accessKeyId: 'SKRROOT',
			secretAccessKey: 'root',
			fetch: async (input, init) => {
				url = input;
				sha = new Headers(init.headers).get('x-amz-content-sha256');
				return new Response('', { status: 200, headers: { etag: '"part-1"' } });
			},
		});
		const body = new TextEncoder().encode('hello');
		expect(await store.uploadPart('media', 'dir/a b.bin', 'up-1', 1, body)).toBe('"part-1"');
		expect(url).toBe('http://127.0.0.1:19001/media/dir/a%20b.bin?partNumber=1&uploadId=up-1');
		expect(sha!).toBe(createHash('sha256').update(body).digest('hex'));
	});

	test('errors carry the S3 code, never the request', async () => {
		const store = new S3ReplicaStore({
			endpoint: 'http://127.0.0.1:19001',
			accessKeyId: 'SKRROOT',
			secretAccessKey: 'root',
			fetch: async () => new Response('<Error><Code>NoSuchBucket</Code><Message>gone</Message></Error>', { status: 404 }),
		});
		const error = await store.listObjects('media', {}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(StorageApiError);
		expect((error as StorageApiError).code).toBe('NoSuchBucket');
	});
});

describe('storage replicator restart', () => {
	test('a link that finished a pass recently waits for its interval after a restart', async () => {
		const ctx = setup({ name: 'restart-wait' });
		writeFileSync(
			ctx.statePath,
			JSON.stringify({ version: 1, links: { srp_1: { lastSyncAt: new Date(ctx.now() - 60_000).toISOString(), buckets: {}, pass: null } } }),
		);
		ctx.local.put('media', 'new.txt', 'new');
		await ctx.replicator.tick();
		expect(ctx.peer.text('media', 'new.txt')).toBeUndefined();
		ctx.advance(840_000);
		await ctx.replicator.tick();
		expect(ctx.peer.text('media', 'new.txt')).toBe('new');
	});
});

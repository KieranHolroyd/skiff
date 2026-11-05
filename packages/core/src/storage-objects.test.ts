import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-objects-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-05T10:00:00Z');

const requests: Array<{ url: string; method: string; headers: Headers; body: Uint8Array | null }> = [];
let listXml = '';
let deleteXml = '';

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
	const method = init?.method ?? 'GET';
	const headers = new Headers(init?.headers);
	const body =
		init?.body instanceof Uint8Array
			? init.body
			: init?.body instanceof ArrayBuffer
				? new Uint8Array(init.body)
				: typeof init?.body === 'string'
					? new TextEncoder().encode(init.body)
					: null;
	requests.push({ url, method, headers, body });
	if (method === 'GET' && new URL(url).searchParams.get('list-type') === '2') {
		return new Response(listXml, { status: 200, headers: { 'content-type': 'application/xml' } });
	}
	if (method === 'POST' && new URL(url).searchParams.has('delete')) {
		return new Response(deleteXml, { status: 200, headers: { 'content-type': 'application/xml' } });
	}
	if (method === 'GET') {
		return new Response('hello object', {
			status: 200,
			headers: { 'content-type': 'text/plain', etag: '"abc123"', 'content-length': '12' },
		});
	}
	if (method === 'HEAD') {
		return new Response(null, {
			status: 200,
			headers: { 'content-type': 'text/plain', etag: '"abc123"', 'content-length': '12' },
		});
	}
	if (method === 'PUT') return new Response(null, { status: 200, headers: { etag: '"def456"' } });
	return new Response('<Error><Code>AccessDenied</Code><Message>nope</Message></Error>', { status: 403 });
}) as typeof fetch;

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		storageGatewayPort: 8081,
		storageObjectMaxBytes: 1024,
		storageFetch: fakeFetch,
		now: () => clock,
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const agent = buildPrincipal({
	kind: 'mcp',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	granted: ['storage:read', 'storage:update'],
});

let storageId = '';
let storageName = 'media';

const storageXml = (contents: string) =>
	`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>uploads</Name><Prefix></Prefix><KeyCount>2</KeyCount><MaxKeys>100</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('storage object browser', () => {
	test('creates a public instance with a bucket', () => {
		const edge = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		core.nodes.update(owner, edge.nodeId, { sliceMemoryMb: 4096 });
		const storage = core.storage.create(owner, {
			name: storageName,
			buckets: ['uploads'],
			public: true,
		});
		storageId = storage.id;
		expect(storage.publicUrl).toBe('https://media--s3.sites.test');
	});

	test('lists objects through the signed gateway request', async () => {
		listXml = storageXml(
			'<Contents><Key>hello.txt</Key><LastModified>2026-11-05T09:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>12</Size><StorageClass>STANDARD</StorageClass></Contents>' +
				'<CommonPrefixes><Prefix>photos/</Prefix></CommonPrefixes>',
		);
		const list = await core.storageObjects.list(owner, storageName, { bucket: 'uploads' });
		expect(list.objects).toEqual([
			{
				key: 'hello.txt',
				sizeBytes: 12,
				etag: 'abc',
				lastModified: '2026-11-05T09:00:00.000Z',
				storageClass: 'STANDARD',
			},
		]);
		expect(list.prefixes).toEqual(['photos/']);

		const request = requests.at(-1)!;
		expect(request.url).toStartWith('http://127.0.0.1:8081/uploads?');
		expect(request.url).toContain('list-type=2');
		expect(request.headers.get('host')).toBe(
			`s3-${storageId.replace(/^st_/, '')}.storage.internal`,
		);
		expect(request.headers.get('authorization')).toStartWith('AWS4-HMAC-SHA256');
	});

	test('uploads, stats, downloads and deletes objects', async () => {
		const stat = await core.storageObjects.upload(
			owner,
			storageName,
			'uploads',
			'notes/readme.txt',
			new TextEncoder().encode('hello'),
			'text/plain',
		);
		expect(stat).toMatchObject({ key: 'notes/readme.txt', sizeBytes: 5, etag: 'def456' });
		const put = requests.at(-1)!;
		expect(put.method).toBe('PUT');
		expect(put.url).toBe('http://127.0.0.1:8081/uploads/notes/readme.txt');
		expect(put.body).toEqual(new TextEncoder().encode('hello'));

		const head = await core.storageObjects.stat(owner, storageName, 'uploads', 'hello.txt');
		expect(head).toMatchObject({ sizeBytes: 12, contentType: 'text/plain', etag: 'abc123' });

		const download = await core.storageObjects.download(owner, storageName, 'uploads', 'hello.txt');
		expect(await download.response.text()).toBe('hello object');

		deleteXml = '<?xml version="1.0"?><DeleteResult><Deleted><Key>hello.txt</Key></Deleted></DeleteResult>';
		const deleted = await core.storageObjects.remove(owner, storageName, 'uploads', { keys: ['hello.txt'] });
		expect(deleted.deleted).toEqual(['hello.txt']);
		const remove = requests.at(-1)!;
		expect(remove.method).toBe('POST');
		expect(remove.headers.get('content-md5')).toBeString();
		expect(new TextDecoder().decode(remove.body!)).toContain('<Key>hello.txt</Key>');

		const actions = core.audit.list({ principal: owner, limit: 20 }).map((entry) => entry.action);
		expect(actions).toContain('storage.object.upload');
		expect(actions).toContain('storage.object.delete');
	});

	test('creates a folder marker', async () => {
		const folder = await core.storageObjects.folder(owner, storageName, 'uploads', 'photos/2026');
		expect(folder.prefix).toBe('photos/2026/');
		const put = requests.at(-1)!;
		expect(put.method).toBe('PUT');
		expect(put.url).toBe('http://127.0.0.1:8081/uploads/photos/2026/');
		expect(put.body?.byteLength).toBe(0);
	});

	test('enforces permissions, bucket membership and the upload cap', async () => {
		await expect(core.storageObjects.list(viewer, storageName, { bucket: 'uploads' })).resolves.toBeDefined();
		await expect(
			core.storageObjects.upload(viewer, storageName, 'uploads', 'x.txt', new Uint8Array([1])),
		).rejects.toThrow(/storage:update/);

		await expect(core.storageObjects.list(owner, storageName, { bucket: 'missing' })).rejects.toThrow(
			/Bucket "missing"/,
		);
		await expect(
			core.storageObjects.upload(owner, storageName, 'uploads', 'big.bin', new Uint8Array(2048)),
		).rejects.toThrow(/limited to 1024 bytes/);
		await expect(core.storageObjects.upload(agent, storageName, 'uploads', '../x', new Uint8Array([1]))).rejects.toThrow();
	});

	test('presigns only public instances', async () => {
		const signed = await core.storageObjects.presign(owner, storageName, 'uploads', {
			key: 'photos/a b.png',
			method: 'GET',
			expiresIn: 600,
		});
		expect(signed.url).toStartWith('https://media--s3.sites.test/uploads/photos/a%20b.png?');
		expect(signed.url).toContain('X-Amz-Signature=');
		expect(signed.url).toContain('X-Amz-Expires=600');

		const privateStorage = core.storage.create(owner, { name: 'private', buckets: ['uploads'] });
		expect(privateStorage.publicUrl).toBeNull();
		await expect(
			core.storageObjects.presign(owner, 'private', 'uploads', { key: 'x', method: 'GET', expiresIn: 60 }),
		).rejects.toThrow(/public instance/);
	});

	test('stores bucket config and enforces object lock immutability', () => {
		const bucket = core.storage.createBucket(owner, storageName, {
			name: 'configured',
			versioning: true,
			lifecycle: [{ id: 'tmp', prefix: 'tmp/', expireDays: 7, abortIncompleteDays: 2 }],
			cors: [{ origin: ['https://app.test'], method: ['GET'], header: [], expose: [] }],
			quotaBytes: 1024 * 1024,
			objectLock: { mode: 'governance', retainDays: 30 },
		});
		expect(bucket).toMatchObject({
			versioning: true,
			quotaBytes: 1024 * 1024,
			objectLock: { mode: 'governance', retainDays: 30 },
			configVersion: 1,
			configStatus: 'pending',
		});
		expect(core.storage.getBucketConfig(owner, storageName, 'configured').lifecycle).toHaveLength(1);
		expect(() => core.storage.updateBucket(owner, storageName, 'configured', { versioning: false })).toThrow(
			/versioning cannot be suspended/,
		);
		expect(() =>
			core.storage.updateBucket(owner, storageName, 'configured', {
				objectLock: { mode: 'governance', retainDays: 30 },
			} as never),
		).toThrow(/cannot be changed/);
		const updated = core.storage.updateBucket(owner, storageName, 'configured', {
			quotaBytes: null,
			lifecycle: [],
		});
		expect(updated).toMatchObject({ quotaBytes: null, lifecycle: [], configVersion: 2, configStatus: 'pending' });
	});

	test('mints direct share links for public instances and never leaks the root key', async () => {
		const secret = core.storage.credentials(owner, storageName).secretAccessKey;
		const link = await core.storageObjects.share(owner, storageName, 'uploads', {
			key: 'photos/a b.png',
			method: 'GET',
			expiresIn: 600,
		});
		expect(link.direct).toBe(true);
		expect(link.url).toStartWith('https://media--s3.sites.test/uploads/photos/a%20b.png?');
		expect(link.url).toContain('X-Amz-Signature=');
		expect(link.expiresIn).toBe(600);
		expect(JSON.stringify(link)).not.toContain(secret);
		expect(core.audit.list({ principal: owner, limit: 10 }).map((entry) => entry.action)).toContain(
			'storage.share.create',
		);
	});

	test('counts downloads on a limited GET link and rejects it afterwards', async () => {
		const link = await core.storageObjects.share(owner, storageName, 'uploads', {
			key: 'hello.txt',
			method: 'GET',
			expiresIn: 600,
			maxDownloads: 1,
		});
		expect(link.direct).toBe(false);
		expect(link.url).toContain('/share/storage/');
		const token = link.url.split('/').at(-1)!;
		const response = await core.storageObjects.redeem(token, new Request(`https://control.test/share/storage/${token}`));
		expect(await response.text()).toBe('hello object');
		await expect(
			core.storageObjects.redeem(token, new Request(`https://control.test/share/storage/${token}`)),
		).rejects.toThrow(/download limit/);
	});

	test('private share links use the gateway and are bound to their method and expiry', async () => {
		const privateStorage = core.storage.create(owner, { name: 'private-share', buckets: ['uploads'] });
		expect(privateStorage.publicUrl).toBeNull();
		const link = await core.storageObjects.share(owner, 'private-share', 'uploads', {
			key: 'hello.txt',
			method: 'GET',
			expiresIn: 60,
		});
		expect(link.direct).toBe(false);
		expect(link.url).toStartWith('https://control.test/share/storage/');
		const token = link.url.split('/').at(-1)!;
		await expect(
			core.storageObjects.redeem(token, new Request(`https://control.test/share/storage/${token}`, { method: 'PUT' })),
		).rejects.toThrow(/GET requests only/);

		clock += 61_000;
		await expect(
			core.storageObjects.redeem(token, new Request(`https://control.test/share/storage/${token}`)),
		).rejects.toThrow(/expired or was revoked/);
		clock -= 61_000;
	});
});

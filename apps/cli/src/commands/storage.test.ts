import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dir = '';
let server: ReturnType<typeof Bun.serve> | undefined;

interface Seen {
	method: string;
	path: string;
	body: unknown;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'skiff-cli-storage-'));
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

const envNames = ['ENDPOINT_URL', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'REGION', 'FORCE_PATH_STYLE', 'BUCKET'].map(
	(suffix) => `S3_${suffix}`,
);

function attachment(projectSlug = 'api', grants = [{ bucket: 'uploads', mode: 'read-write' }]) {
	return {
		storageId: 'st_1',
		storageName: 'media',
		projectId: 'prj_1',
		projectSlug,
		envPrefix: 'S3',
		envNames,
		grants,
		accessKeyId: 'SKFABCDEFGHIJKLMNOPQ',
		createdAt: '2026-11-05T10:00:00.000Z',
	};
}

function bucket(name = 'uploads', overrides: Record<string, unknown> = {}) {
	return {
		name,
		access: 'private',
		state: 'ready',
		sizeBytes: 3 * 1024 * 1024,
		objects: 42,
		versioning: false,
		lifecycle: [],
		cors: [],
		quotaBytes: null,
		objectLock: null,
		configVersion: 1,
		configStatus: 'pending',
		configMessage: null,
		lastConvergedAt: null,
		createdAt: '2026-11-05T10:00:00.000Z',
		statsAt: '2026-11-05T11:00:00.000Z',
		...overrides,
	};
}

function view(overrides: Record<string, unknown> = {}) {
	return {
		id: 'st_1',
		name: 'media',
		engine: 'rustfs',
		engineLabel: 'RustFS',
		version: '1.0.4',
		status: 'running',
		message: null,
		nodeId: 'node_home',
		nodeName: 'homelab',
		memoryMb: 512,
		cpus: 1,
		storageMb: 10_240,
		usedBytes: 1024 * 1024 * 1024,
		objects: 42,
		public: false,
		publicUrl: null,
		internalEndpoint: { process: 'http://127.0.0.1:19000', container: 'http://s3-1:9000' },
		region: 'us-east-1',
		buckets: [bucket()],
		attachments: [],
		statsAt: '2026-11-05T11:00:00.000Z',
		createdAt: '2026-11-05T10:00:00.000Z',
		updatedAt: '2026-11-05T10:00:00.000Z',
		deletedAt: null,
		purgeAt: null,
		...overrides,
	};
}

/** A fake control plane: `routes` maps `METHOD /path` to a JSON body (or a Response). */
function serve(routes: Record<string, unknown>): Seen[] {
	const seen: Seen[] = [];
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const text = await request.text();
			seen.push({ method: request.method, path: `${url.pathname}${url.search}`, body: text ? JSON.parse(text) : undefined });
			const route = routes[`${request.method} ${url.pathname}${url.search}`] ?? routes[`${request.method} ${url.pathname}`];
			if (route === undefined) return Response.json({ error: 'not_found', message: 'no route' }, { status: 404 });
			return route instanceof Response ? route : Response.json(route);
		},
	});
	return seen;
}

async function cli(...args: string[]) {
	const child = Bun.spawn([process.execPath, 'src/main.ts', ...args], {
		cwd: join(import.meta.dir, '../..'),
		env: {
			...process.env,
			SKIFF_CONFIG_DIR: dir,
			SKIFF_URL: `http://127.0.0.1:${server!.port}`,
			SKIFF_TOKEN: 'skif_test',
			SKIFF_CONTENT_DOMAIN: '',
			SKIFF_PROFILE: '',
		},
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const code = await child.exited;
	return { code, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

describe('skif storage', () => {
	test('create sends buckets, project, prefix, public and limits in one call', async () => {
		const seen = serve({
			'POST /api/v1/storage': {
				storage: view({
					status: 'pending',
					public: true,
					publicUrl: 'https://media--s3.example.com',
					buckets: [bucket('uploads'), bucket('thumbs')],
					attachments: [attachment()],
				}),
			},
		});
		const result = await cli(
			'storage', 'create', 'media',
			'--bucket', 'uploads', '-b', 'thumbs',
			'--project', 'api', '--prefix', 'AWS',
			'--public', '--placement', 'edge', '--memory', '1G', '--cpus', '0.5', '--storage', '20G',
		);
		expect(result.code).toBe(0);
		expect(seen[0]).toEqual({
			method: 'POST',
			path: '/api/v1/storage',
			body: {
				name: 'media',
				buckets: ['uploads', 'thumbs'],
				project: 'api',
				envPrefix: 'AWS',
				public: true,
				placement: 'edge',
				memoryMb: 1024,
				cpus: 0.5,
				storageMb: 20_480,
			},
		});
		expect(result.stdout).toContain('Created storage "media" with 2 buckets on node homelab (pending).');
		expect(result.stdout).toContain('Public endpoint: https://media--s3.example.com');
		expect(result.stdout).toContain('Attached to api as S3');
		expect(result.stdout).not.toContain('skif storage attach');
	});

	test('create --project without --bucket is refused before calling the server', async () => {
		const seen = serve({});
		const result = await cli('storage', 'create', 'media', '--project', 'api');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('--project needs at least one --bucket');
		expect(seen).toHaveLength(0);
	});

	test('attach without --bucket grants read-write on the only bucket', async () => {
		const seen = serve({
			'GET /api/v1/storage/media': { storage: view() },
			'POST /api/v1/projects/api/storage': {
				attachment: attachment(),
				warning: '"api" has no running workload yet. Its next deploy is placed next to "media".',
			},
		});
		const result = await cli('storage', 'attach', 'media', '--project', 'api');
		expect(result.code).toBe(0);
		expect(seen.at(-1)?.body).toEqual({ storage: 'media', grants: [{ bucket: 'uploads', mode: 'read-write' }] });
		expect(result.stdout).toContain('Attached "media" to api as S3 (uploads:read-write).');
		expect(result.stdout).toContain('S3_ENDPOINT_URL');
		expect(result.stdout).toContain('Note: "api" has no running workload yet.');
	});

	test('attach without --bucket errors when there are several buckets', async () => {
		const seen = serve({ 'GET /api/v1/storage/media': { storage: view({ buckets: [bucket('a1a'), bucket('b2b')] }) } });
		const result = await cli('storage', 'attach', 'media', '-p', 'api');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('has 2 buckets (a1a, b2b)');
		expect(result.stderr).toContain('--bucket');
		expect(seen.some((item) => item.method === 'POST')).toBe(false);
	});

	test('attach posts explicit grants and the prefix without a lookup', async () => {
		const seen = serve({ 'POST /api/v1/projects/api/storage': { attachment: attachment(), warning: null } });
		const result = await cli('storage', 'attach', 'media', '-p', 'api', '--bucket', 'uploads:read', '--bucket', 'thumbs', '--prefix', 'AWS');
		expect(result.code).toBe(0);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.body).toEqual({
			storage: 'media',
			envPrefix: 'AWS',
			grants: [
				{ bucket: 'uploads', mode: 'read' },
				{ bucket: 'thumbs', mode: 'read-write' },
			],
		});
	});

	test('grants replaces the attachment grants with PATCH', async () => {
		const grants = [{ bucket: 'uploads', mode: 'read' }];
		const seen = serve({ 'PATCH /api/v1/projects/api/storage/media': { attachment: attachment('api', grants) } });
		const result = await cli('storage', 'grants', 'media', '-p', 'api', '-b', 'uploads:read');
		expect(result.code).toBe(0);
		expect(seen[0]).toEqual({ method: 'PATCH', path: '/api/v1/projects/api/storage/media', body: { grants } });
		expect(result.stdout).toContain('api now has uploads:read on "media".');
	});

	test('detach needs --project and sends DELETE', async () => {
		let seen = serve({});
		const missing = await cli('storage', 'detach', 'media');
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain('skif storage detach media --project <slug>');
		server?.stop(true);
		seen = serve({ 'DELETE /api/v1/projects/api/storage/media': { ok: true } });
		const result = await cli('storage', 'detach', 'media', '-p', 'api');
		expect(result.code).toBe(0);
		expect(seen[0]?.method).toBe('DELETE');
		expect(result.stdout).toContain('Detached "media" from api.');
	});

	test('credentials prints env lines (AWS by default); --json prints everything', async () => {
		const credentials = {
			storageId: 'st_1',
			name: 'media',
			accessKeyId: 'SKRABCDEFGHIJKLMNOPQ',
			secretAccessKey: 's3cret-key_value',
			region: 'us-east-1',
			endpoint: 'http://127.0.0.1:19000',
			internalEndpoint: 'http://127.0.0.1:19000',
			publicEndpoint: null,
			note: 'Private: listens on loopback on node "homelab" only.',
		};
		serve({ 'GET /api/v1/storage/media/credentials': { credentials } });
		const plain = await cli('storage', 'credentials', 'media');
		expect(plain.code).toBe(0);
		expect(plain.stdout).toBe(
			[
				'AWS_ENDPOINT_URL=http://127.0.0.1:19000',
				'AWS_ACCESS_KEY_ID=SKRABCDEFGHIJKLMNOPQ',
				'AWS_SECRET_ACCESS_KEY=s3cret-key_value',
				'AWS_REGION=us-east-1',
				'AWS_FORCE_PATH_STYLE=true',
				'',
			].join('\n'),
		);
		const prefixed = await cli('storage', 'credentials', 'media', '--prefix', 'S3');
		expect(prefixed.stdout).toStartWith('S3_ENDPOINT_URL=');
		const json = await cli('storage', 'credentials', 'media', '--json');
		expect(JSON.parse(json.stdout)).toEqual({ credentials });
	});

	test('info shows status, endpoints, usage, buckets and attachments', async () => {
		const seen = serve({ 'GET /api/v1/storage/media': { storage: view({ attachments: [attachment()] }) } });
		const result = await cli('storage', 'info', 'media');
		expect(result.code).toBe(0);
		expect(seen[0]?.path).toBe('/api/v1/storage/media?includeDeleted=1');
		expect(result.stdout).toMatch(/Status\s+running/);
		expect(result.stdout).toContain('homelab (node_home)');
		expect(result.stdout).toContain('1.0 GiB / 10 GiB (10%)');
		expect(result.stdout).toMatch(/uploads\s+private\s+ready\s+3\.0 MiB\s+42/);
		expect(result.stdout).toMatch(/api\s+S3\s+uploads:read-write\s+SKF/);
	});

	test('list prints a table, and the empty state', async () => {
		serve({ 'GET /api/v1/storage?includeDeleted=1': { storage: [view({ attachments: [attachment()] })] } });
		const result = await cli('storage', 'list', '--all');
		expect(result.stdout).toMatch(/NAME\s+STATUS\s+NODE\s+BUCKETS/);
		expect(result.stdout).toMatch(/media\s+running\s+homelab\s+1\s+1\.0 GiB/);
		server?.stop(true);
		serve({ 'GET /api/v1/storage': { storage: [] } });
		expect((await cli('storage')).stdout).toContain('No storage yet.');
	});

	test('update maps --no-public and limits to a PATCH', async () => {
		const seen = serve({ 'PATCH /api/v1/storage/media': { storage: view({ memoryMb: 1024 }) } });
		const result = await cli('storage', 'update', 'media', '--no-public', '--memory', '1G');
		expect(result.code).toBe(0);
		expect(seen[0]?.body).toEqual({ public: false, memoryMb: 1024 });
		expect(result.stdout).toContain('Updated "media": 1024 MB memory');
	});

	test('update with nothing to change is a usage error', async () => {
		const seen = serve({});
		const result = await cli('storage', 'update', 'media');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Nothing to update');
		expect(seen).toHaveLength(0);
	});

	test('metrics --since computes from and passes the interval', async () => {
		const seen = serve({
			'GET /api/v1/storage/media/metrics': {
				points: [{ bucket: '2026-11-05T11:00:00.000Z', up: 1, usedBytes: 2048, objects: 3, bucketCount: 1, memoryBytes: 1024 * 1024 }],
				interval: '1h',
			},
		});
		const result = await cli('storage', 'metrics', 'media', '--since', '6h', '--to', '2026-11-05T12:00:00Z', '--interval', '1h');
		expect(result.code).toBe(0);
		const url = new URL(`http://x${seen[0]!.path}`);
		expect(url.searchParams.get('from')).toBe('2026-11-05T06:00:00.000Z');
		expect(url.searchParams.get('to')).toBe('2026-11-05T12:00:00Z');
		expect(url.searchParams.get('interval')).toBe('1h');
		expect(result.stdout).toContain('1 sample at 1h:');
		expect(result.stdout).toMatch(/2026-11-05 11:00:00Z\s+yes\s+2\.0 KiB\s+3\s+1\s+1\.0 MiB/);
	});

	test('delete refuses while attached, before asking', async () => {
		const seen = serve({ 'GET /api/v1/storage/media': { storage: view({ attachments: [attachment()] }) } });
		const result = await cli('storage', 'delete', 'media', '--yes');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('is attached to api');
		expect(result.stderr).toContain('skif storage detach media --project api');
		expect(seen.some((item) => item.method === 'DELETE')).toBe(false);
	});

	test('delete --yes soft-deletes and prints the undo', async () => {
		const seen = serve({
			'GET /api/v1/storage/media': { storage: view() },
			'DELETE /api/v1/storage/media': {
				storage: view({ status: 'stopped', deletedAt: '2026-11-05T12:00:00.000Z', purgeAt: '2026-11-12T12:00:00.000Z' }),
			},
		});
		const result = await cli('storage', 'delete', 'media', '--yes');
		expect(result.code).toBe(0);
		expect(seen.at(-1)?.path).toBe('/api/v1/storage/media');
		expect(result.stdout).toContain('Undo: skif storage restore media');
	});

	test('purge --yes on a trashed instance sends DELETE ?purge=1; off a terminal it refuses without --yes', async () => {
		const seen = serve({
			'GET /api/v1/storage/media?includeDeleted=1': { storage: view({ deletedAt: '2026-11-05T12:00:00.000Z' }) },
			'DELETE /api/v1/storage/media?purge=1': { ok: true },
		});
		const refused = await cli('storage', 'purge', 'media');
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain('Not confirmed');
		expect(seen.some((item) => item.method === 'DELETE')).toBe(false);
		const result = await cli('storage', 'purge', 'media', '--yes', '--json');
		expect(result.code).toBe(0);
		expect(seen.at(-1)).toEqual({ method: 'DELETE', path: '/api/v1/storage/media?purge=1', body: undefined });
		expect(JSON.parse(result.stdout)).toEqual({ ok: true });
	});

	test('restore surfaces server errors as JSON with --json', async () => {
		serve({
			'POST /api/v1/storage/media/restore': new Response(
				JSON.stringify({ error: 'conflict', message: 'Storage "media" is being purged and can no longer be restored.' }),
				{ status: 409, headers: { 'content-type': 'application/json' } },
			),
		});
		const result = await cli('storage', 'restore', 'media', '--json');
		expect(result.code).toBe(1);
		const payload = JSON.parse(result.stderr) as { error: { code: string; status: number; message: string } };
		expect(payload.error.code).toBe('conflict');
		expect(payload.error.status).toBe(409);
	});
});

describe('skif storage buckets', () => {
	test('`buckets <name>` lists, like `buckets list <name>`', async () => {
		const seen = serve({ 'GET /api/v1/storage/media/buckets': { buckets: [bucket()] } });
		const short = await cli('storage', 'buckets', 'media');
		expect(short.code).toBe(0);
		expect(short.stdout).toMatch(/BUCKET\s+ACCESS\s+STATE/);
		const long = await cli('storage', 'buckets', 'list', 'media', '--json');
		expect(JSON.parse(long.stdout)).toEqual({ buckets: [bucket()] });
		expect(seen.map((item) => item.path)).toEqual(['/api/v1/storage/media/buckets', '/api/v1/storage/media/buckets']);
	});

	test('create and update send the access', async () => {
		const seen = serve({
			'POST /api/v1/storage/media/buckets': { bucket: bucket('avatars', { access: 'public-read' }) },
			'PATCH /api/v1/storage/media/buckets/avatars': { bucket: bucket('avatars') },
		});
		const created = await cli('storage', 'buckets', 'create', 'media', 'avatars', '--access', 'public-read');
		expect(created.code).toBe(0);
		expect(seen[0]?.body).toEqual({ name: 'avatars', access: 'public-read' });
		expect(created.stdout).toContain('Created bucket "avatars" in "media" (public-read).');
		const updated = await cli('storage', 'buckets', 'update', 'media', 'avatars', '--access', 'private');
		expect(updated.code).toBe(0);
		expect(seen[1]).toEqual({ method: 'PATCH', path: '/api/v1/storage/media/buckets/avatars', body: { access: 'private' } });
	});

	test('create rejects an unknown access before calling the server', async () => {
		const seen = serve({});
		const result = await cli('storage', 'buckets', 'create', 'media', 'avatars', '--access', 'public');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('--access expects private or public-read');
		expect(seen).toHaveLength(0);
	});

	test('delete --force sends ?force=1 and needs confirmation', async () => {
		const seen = serve({ 'DELETE /api/v1/storage/media/buckets/uploads?force=1': { bucket: bucket('uploads', { state: 'deleting' }) } });
		const refused = await cli('storage', 'buckets', 'delete', 'media', 'uploads', '--force');
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain('Not confirmed');
		expect(seen).toHaveLength(0);
		const result = await cli('storage', 'buckets', 'delete', 'media', 'uploads', '--force', '--yes');
		expect(result.code).toBe(0);
		expect(seen[0]).toEqual({ method: 'DELETE', path: '/api/v1/storage/media/buckets/uploads?force=1', body: undefined });
		expect(result.stdout).toContain('and its objects');
	});

	test('delete without --force sends a plain DELETE', async () => {
		const seen = serve({ 'DELETE /api/v1/storage/media/buckets/uploads': { bucket: bucket('uploads', { state: 'deleting' }) } });
		const result = await cli('storage', 'buckets', 'delete', 'media', 'uploads', '-y');
		expect(result.code).toBe(0);
		expect(seen[0]?.path).toBe('/api/v1/storage/media/buckets/uploads');
	});
});

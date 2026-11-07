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
	dir = await mkdtemp(join(tmpdir(), 'skiff-cli-db-'));
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

const envNames = ['URL', 'HOST', 'PORT', 'USER', 'PASSWORD', 'NAME'].map((suffix) => `DATABASE_${suffix}`);

function attachment(projectSlug = 'api') {
	return {
		databaseId: 'db_1',
		databaseName: 'main',
		projectId: 'prj_1',
		projectSlug,
		envPrefix: 'DATABASE',
		envNames,
		createdAt: '2026-11-04T10:00:00.000Z',
	};
}

function view(overrides: Record<string, unknown> = {}) {
	return {
		id: 'db_1',
		name: 'main',
		engine: 'postgres',
		engineLabel: 'PostgreSQL',
		version: '17',
		status: 'running',
		message: null,
		nodeId: 'node_home',
		nodeName: 'homelab',
		memoryMb: 256,
		cpus: 1,
		storageMb: 10_240,
		sizeBytes: 2 * 1024 * 1024 * 1024,
		databaseName: 'main',
		username: 'main',
		internalHost: { process: '127.0.0.1:15432', container: 'db-1:5432' },
		attachments: [],
		tables: [],
		statsAt: null,
		createdAt: '2026-11-04T10:00:00.000Z',
		updatedAt: '2026-11-04T10:00:00.000Z',
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

describe('skif db', () => {
	test('create --project attaches in one call and prints next steps', async () => {
		const seen = serve({ 'POST /api/v1/databases': { database: view({ status: 'pending', attachments: [attachment()] }) } });
		const result = await cli('db', 'create', 'main', '--project', 'api', '--storage', '20G');
		expect(result.code).toBe(0);
		expect(seen[0]).toEqual({
			method: 'POST',
			path: '/api/v1/databases',
			body: { name: 'main', project: 'api', storageMb: 20_480 },
		});
		expect(result.stdout).toContain('Created PostgreSQL 17 database "main" on node homelab (pending).');
		expect(result.stdout).toContain('Attached to api as DATABASE');
		expect(result.stdout).toContain('skif db info main');
		expect(result.stdout).not.toContain('skif db attach');
	});

	test('create rejects --prefix without --project before calling the server', async () => {
		const seen = serve({});
		const result = await cli('db', 'create', 'main', '--prefix', 'DB');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('--prefix needs --project');
		expect(seen).toHaveLength(0);
	});

	test('attach posts the prefix and shows the warning', async () => {
		const seen = serve({
			'POST /api/v1/projects/api/databases': {
				attachment: attachment(),
				warning: '"api" has no running workload yet. Its next deploy is placed next to "main".',
			},
		});
		const result = await cli('db', 'attach', 'main', '--project', 'api', '--prefix', 'DATABASE');
		expect(result.code).toBe(0);
		expect(seen[0]?.body).toEqual({ database: 'main', envPrefix: 'DATABASE' });
		expect(result.stdout).toContain('Attached "main" to api as DATABASE.');
		expect(result.stdout).toContain('DATABASE_URL');
		expect(result.stdout).toContain('Note: "api" has no running workload yet.');
	});

	test('attach and detach need --project', async () => {
		serve({});
		const result = await cli('db', 'detach', 'main');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('skif db detach main --project <slug>');
	});

	test('detach sends DELETE to the project attachment', async () => {
		const seen = serve({ 'DELETE /api/v1/projects/api/databases/main': { ok: true } });
		const result = await cli('db', 'detach', 'main', '-p', 'api');
		expect(result.code).toBe(0);
		expect(seen[0]?.method).toBe('DELETE');
		expect(result.stdout).toContain('Detached "main" from api.');
	});

	test('credentials prints only the URL; --json prints everything', async () => {
		const credentials = {
			databaseId: 'db_1',
			name: 'main',
			username: 'main',
			password: 's3cret',
			databaseName: 'main',
			url: 'postgres://main:s3cret@127.0.0.1:15432/main',
			host: '127.0.0.1',
			port: 15432,
			note: 'Listens on loopback on node "homelab" only.',
		};
		serve({ 'GET /api/v1/databases/main/credentials': { credentials } });
		const plain = await cli('db', 'credentials', 'main');
		expect(plain.code).toBe(0);
		expect(plain.stdout).toBe(`${credentials.url}\n`);
		const json = await cli('db', 'credentials', 'main', '--json');
		expect(JSON.parse(json.stdout)).toEqual({ credentials });
	});

	const named = {
		id: 'dbc_1',
		databaseId: 'db_1',
		role: 'readonly',
		username: 'skiff_readonly_ab12cd34',
		purpose: 'BI',
		status: 'ready',
		lastUsedAt: null,
		expiresAt: null,
		createdAt: '2026-11-04T10:00:00.000Z',
		revokedAt: null,
	};

	test('credentials list and create talk to the named-credential routes', async () => {
		const seen = serve({
			'GET /api/v1/databases/main/credentials/named': { credentials: [named] },
			'POST /api/v1/databases/main/credentials/named': { credential: { ...named, status: 'pending' } },
		});
		const list = await cli('db', 'credentials', 'list', 'main');
		expect(list.code).toBe(0);
		expect(list.stdout).toContain('skiff_readonly_ab12cd34');
		expect(list.stdout).toContain('readonly');
		const created = await cli('db', 'credentials', 'create', 'main', '--role', 'readonly', '--purpose', 'BI');
		expect(created.code).toBe(0);
		expect(seen[1]).toEqual({
			method: 'POST',
			path: '/api/v1/databases/main/credentials/named',
			body: { role: 'readonly', purpose: 'BI' },
		});
		expect(created.stdout).toContain('--credential dbc_1');
		const bad = await cli('db', 'credentials', 'create', 'main', '--role', 'owner');
		expect(bad.code).not.toBe(0);
		expect(bad.stderr).toContain('--role must be one of app, readonly, backup');
	});

	test('credentials rotate, revoke (with --yes) and reveal', async () => {
		const seen = serve({
			'POST /api/v1/databases/main/credentials/named/dbc_1/rotate': { credential: { ...named, status: 'pending' } },
			'DELETE /api/v1/databases/main/credentials/named/dbc_1': { credential: { ...named, status: 'revoking' } },
			'GET /api/v1/databases/main/credentials/named/dbc_1': { credential: { ...named, password: 'pw-123' } },
		});
		expect((await cli('db', 'credentials', 'rotate', 'main', 'dbc_1')).code).toBe(0);
		const refused = await cli('db', 'credentials', 'revoke', 'main', 'dbc_1');
		expect(refused.code).not.toBe(0);
		expect(seen.some((item) => item.method === 'DELETE')).toBe(false);
		expect((await cli('db', 'credentials', 'revoke', 'main', 'dbc_1', '--yes')).code).toBe(0);
		const revealed = await cli('db', 'credentials', 'reveal', 'main', 'dbc_1');
		expect(revealed.stdout).toBe('pw-123\n');
		expect(seen.map((item) => `${item.method} ${item.path}`)).toEqual([
			'POST /api/v1/databases/main/credentials/named/dbc_1/rotate',
			'DELETE /api/v1/databases/main/credentials/named/dbc_1',
			'GET /api/v1/databases/main/credentials/named/dbc_1',
		]);
	});

	test('attach --credential sends the credential reference', async () => {
		const seen = serve({
			'POST /api/v1/projects/reports/databases': {
				attachment: { ...attachment('reports'), credentialId: 'dbc_1', credentialRole: 'readonly' },
				warning: null,
			},
		});
		const result = await cli('db', 'attach', 'main', '--project', 'reports', '--credential', 'readonly');
		expect(result.code).toBe(0);
		expect(seen[0]!.body).toEqual({ database: 'main', credential: 'readonly' });
		expect(result.stdout).toContain('connecting as the readonly credential');
	});

	test('info shows status, node, size vs budget, attachments and top tables', async () => {
		const seen = serve({
			'GET /api/v1/databases/main': {
				database: view({
					attachments: [attachment()],
					statsAt: '2026-11-04T11:55:00.000Z',
					tables: [
						{ schema: 'public', name: 'users', rows: 1500, totalBytes: 8 * 1024 * 1024, seqScans: 2, idxScans: 900, lastAutovacuum: null, lastAutoanalyze: null },
					],
				}),
			},
		});
		const result = await cli('db', 'info', 'main');
		expect(result.code).toBe(0);
		expect(seen[0]?.path).toBe('/api/v1/databases/main?includeDeleted=1');
		expect(result.stdout).toMatch(/Status\s+running/);
		expect(result.stdout).toContain('homelab (node_home)');
		expect(result.stdout).toContain('2.0 GiB / 10 GiB (20%)');
		expect(result.stdout).toMatch(/api\s+DATABASE\s+DATABASE_URL/);
		expect(result.stdout).toMatch(/public\.users\s+1,500\s+8\.0 MiB/);
	});

	test('list prints a table, and the empty state', async () => {
		serve({ 'GET /api/v1/databases?includeDeleted=1': { databases: [view({ attachments: [attachment()] })] } });
		const result = await cli('db', 'list', '--all');
		expect(result.stdout).toMatch(/NAME\s+STATUS\s+ENGINE/);
		expect(result.stdout).toMatch(/main\s+running\s+PostgreSQL 17\s+homelab/);
		server?.stop(true);
		serve({ 'GET /api/v1/databases': { databases: [] } });
		expect((await cli('db')).stdout).toContain('No databases yet.');
	});

	test('delete refuses while attached, before asking', async () => {
		const seen = serve({ 'GET /api/v1/databases/main': { database: view({ attachments: [attachment()] }) } });
		const result = await cli('db', 'delete', 'main', '--yes');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('is attached to api');
		expect(result.stderr).toContain('skif db detach main --project api');
		expect(seen.some((item) => item.method === 'DELETE')).toBe(false);
	});

	test('delete --yes soft-deletes and prints the undo', async () => {
		const seen = serve({
			'GET /api/v1/databases/main': { database: view() },
			'DELETE /api/v1/databases/main': {
				database: view({ status: 'stopped', deletedAt: '2026-11-04T12:00:00.000Z', purgeAt: '2026-11-11T12:00:00.000Z' }),
			},
		});
		const result = await cli('db', 'delete', 'main', '--yes');
		expect(result.code).toBe(0);
		expect(seen.at(-1)?.path).toBe('/api/v1/databases/main');
		expect(result.stdout).toContain('Undo: skif db restore main');
	});

	test('purge needs a typed confirmation: off a terminal it refuses without --yes', async () => {
		const seen = serve({ 'GET /api/v1/databases/main?includeDeleted=1': { database: view({ deletedAt: '2026-11-04T12:00:00.000Z' }) } });
		const result = await cli('db', 'purge', 'main');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Not confirmed');
		expect(result.stderr).toContain('--yes');
		expect(seen.some((item) => item.method === 'DELETE')).toBe(false);
	});

	test('purge --yes on a trashed database sends DELETE ?purge=1', async () => {
		const seen = serve({
			'GET /api/v1/databases/main?includeDeleted=1': { database: view({ deletedAt: '2026-11-04T12:00:00.000Z' }) },
			'DELETE /api/v1/databases/main?purge=1': { ok: true },
		});
		const result = await cli('db', 'purge', 'main', '--yes', '--json');
		expect(result.code).toBe(0);
		expect(seen.at(-1)).toEqual({ method: 'DELETE', path: '/api/v1/databases/main?purge=1', body: undefined });
		expect(JSON.parse(result.stdout)).toEqual({ ok: true });
	});

	test('purge refuses a database that is not in the trash', async () => {
		const seen = serve({ 'GET /api/v1/databases/main?includeDeleted=1': { database: view() } });
		const result = await cli('db', 'purge', 'main', '--yes');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('not in the trash');
		expect(seen.some((item) => item.method === 'DELETE')).toBe(false);
	});

	test('update sends only the flags given as a PATCH', async () => {
		const seen = serve({ 'PATCH /api/v1/databases/main': { database: view({ memoryMb: 512, storageMb: 20_480 }) } });
		const result = await cli('db', 'update', 'main', '--memory', '512M', '--storage', '20G', '--no-pooler');
		expect(result.code).toBe(0);
		expect(seen).toEqual([
			{ method: 'PATCH', path: '/api/v1/databases/main', body: { memoryMb: 512, storageMb: 20_480, pooler: false } },
		]);
		expect(result.stdout).toContain('Updated "main" (PostgreSQL 17).');
		expect(result.stdout).toContain('It restarts on node homelab with the change.');
	});

	test('update --extension adds to the enabled list instead of replacing it', async () => {
		const seen = serve({
			'GET /api/v1/databases/main': { database: view({ extensions: ['pg_trgm'] }) },
			'PATCH /api/v1/databases/main': { database: view({ extensions: ['pg_trgm', 'citext'] }) },
		});
		const result = await cli('db', 'update', 'main', '--extension', 'citext', '--extension', 'pg_trgm');
		expect(result.code).toBe(0);
		expect(seen.at(-1)).toEqual({
			method: 'PATCH',
			path: '/api/v1/databases/main',
			body: { extensions: ['pg_trgm', 'citext'] },
		});
	});

	test('update --version asks first: off a terminal it needs --yes', async () => {
		const seen = serve({ 'PATCH /api/v1/databases/main': { database: view({ engine: 'mysql', engineLabel: 'MySQL', version: '9.7' }) } });
		const refused = await cli('db', 'update', 'main', '--version', '9.7');
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain('Refusing to change the version without confirmation.');
		expect(seen).toHaveLength(0);
		const confirmed = await cli('db', 'update', 'main', '--version', '9.7', '--yes', '--json');
		expect(confirmed.code).toBe(0);
		expect(seen).toEqual([{ method: 'PATCH', path: '/api/v1/databases/main', body: { version: '9.7' } }]);
	});

	test('update with nothing to change fails before calling the server', async () => {
		const seen = serve({});
		const result = await cli('db', 'update', 'main');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Nothing to update.');
		expect(seen).toHaveLength(0);
	});

	test('server errors surface as JSON with --json', async () => {
		serve({
			'POST /api/v1/databases/main/restore': new Response(
				JSON.stringify({ error: 'conflict', message: 'Database "main" is being purged and can no longer be restored.' }),
				{ status: 409, headers: { 'content-type': 'application/json' } },
			),
		});
		const result = await cli('db', 'restore', 'main', '--json');
		expect(result.code).toBe(1);
		const payload = JSON.parse(result.stderr) as { error: { code: string; status: number; message: string } };
		expect(payload.error.code).toBe('conflict');
		expect(payload.error.status).toBe(409);
		expect(payload.error.message).toContain('being purged');
	});
});

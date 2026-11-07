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
	dir = await mkdtemp(join(tmpdir(), 'skiff-cli-pitr-'));
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

function pitr(overrides: Record<string, unknown> = {}) {
	return {
		databaseId: 'db_1',
		databaseName: 'main',
		enabled: true,
		stanza: 'db_1',
		status: 'ok',
		repo: { kind: 's3', endpoint: null, bucket: 'skiff-pitr', region: 'us-east-1', pathPrefix: 'skiff/pitr', forcePathStyle: true },
		archiveStatus: 'ok',
		archiveAt: '2026-11-07T10:00:00.000Z',
		lastBaseBackupAt: '2026-11-07T02:00:00.000Z',
		lastBaseBackupType: 'full',
		nextFullAt: '2026-11-08T02:00:00.000Z',
		nextDiffAt: '2026-11-09T02:00:00.000Z',
		lastRestoreTargetAt: null,
		lastRestoreDatabaseId: null,
		verifiedAt: null,
		error: null,
		recoverableFrom: '2026-11-07T02:05:00.000Z',
		recoverableTo: '2026-11-07T09:59:00.000Z',
		windowCheckedAt: '2026-11-07T10:00:00.000Z',
		...overrides,
	};
}

function serve(routes: Record<string, unknown>): Seen[] {
	const seen: Seen[] = [];
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const text = await request.text();
			seen.push({ method: request.method, path: url.pathname, body: text ? JSON.parse(text) : undefined });
			const route = routes[`${request.method} ${url.pathname}`];
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

describe('skif db pitr', () => {
	test('shows the archive and the recoverable window', async () => {
		serve({ 'GET /api/v1/databases/main/pitr': { pitr: pitr() } });
		const result = await cli('db', 'pitr', 'main');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('enabled (ok)');
		expect(result.stdout).toContain('s3://skiff-pitr/skiff/pitr/db_1');
		expect(result.stdout).toContain('Recoverable:');
		expect(result.stdout).toContain('and later while the archive is healthy');
	});

	test('--enable sends a PATCH; --disable needs --yes off a terminal', async () => {
		const seen = serve({ 'PATCH /api/v1/databases/main/pitr': { pitr: pitr({ status: 'pending', recoverableFrom: null, recoverableTo: null }) } });
		const enabled = await cli('db', 'pitr', 'main', '--enable');
		expect(enabled.code).toBe(0);
		expect(seen.at(-1)).toEqual({ method: 'PATCH', path: '/api/v1/databases/main/pitr', body: { enabled: true } });
		expect(enabled.stdout).toContain('first full backup');
		expect(enabled.stdout).toContain('nothing yet');

		const refused = await cli('db', 'pitr', 'main', '--disable');
		expect(refused.code).not.toBe(0);
		expect(seen).toHaveLength(1);
		const disabled = await cli('db', 'pitr', 'main', '--disable', '--yes');
		expect(disabled.code).toBe(0);
		expect(seen.at(-1)?.body).toEqual({ enabled: false });
	});

	test('pitr-backup posts the type', async () => {
		const seen = serve({
			'POST /api/v1/databases/main/pitr/backups': {
				task: { id: 'pitr_1', action: 'basebackup', databaseId: 'db_1', baseBackupType: 'diff' },
			},
		});
		const result = await cli('db', 'pitr-backup', 'main', '--type', 'diff');
		expect(result.code).toBe(0);
		expect(seen.at(-1)?.body).toEqual({ type: 'diff' });
		expect(result.stdout).toContain('pitr_1');
		expect((await cli('db', 'pitr-backup', 'main', '--type', 'snapshot')).code).not.toBe(0);
	});

	test('restore-to needs --time with an offset and --as, then posts both', async () => {
		const seen = serve({
			'POST /api/v1/databases/main/pitr/restore': {
				database: {
					id: 'db_2',
					name: 'main-pitr',
					engine: 'postgres',
					version: '18',
					status: 'pending',
					nodeId: 'node_home',
					nodeName: 'homelab',
					attachments: [],
				},
			},
		});
		expect((await cli('db', 'restore-to', 'main', '--as', 'main-pitr')).code).not.toBe(0);
		expect((await cli('db', 'restore-to', 'main', '--time', '2026-11-07T09:30:00', '--as', 'main-pitr')).code).not.toBe(0);
		expect((await cli('db', 'restore-to', 'main', '--time', '2026-11-07T09:30:00Z')).code).not.toBe(0);
		expect(seen).toHaveLength(0);
		const result = await cli('db', 'restore-to', 'main', '--time', '2026-11-07T10:30:00+01:00', '--as', 'main-pitr');
		expect(result.code).toBe(0);
		expect(seen.at(-1)?.body).toEqual({ name: 'main-pitr', targetTime: '2026-11-07T09:30:00.000Z' });
		expect(result.stdout).toContain('into "main-pitr" on node homelab');
	});
});

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-backup-targets-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-04T10:00:00Z');

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const other = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_2', role: 'owner' });
const secret = 'super-secret-access-key-value';

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

/** Minimal S3 double: head/put/list/delete, with delete denied for the write-only case. */
function fakeS3(options: { deleteStatus?: number } = {}) {
	const objects = new Map<string, Uint8Array>();
	const calls: string[] = [];
	const bucket = 'backups';
	const keyFor = (url: URL) =>
		decodeURIComponent(url.pathname).replace(new RegExp(`^/${bucket}/?`), '');
	const fetchImpl = (async (input: Request | string | URL) => {
		const request = input instanceof Request ? input : new Request(String(input));
		const url = new URL(request.url);
		const key = keyFor(url);
		calls.push(`${request.method} ${key}`);
		if (request.method === 'HEAD') return new Response(null, { status: 200 });
		if (request.method === 'PUT') {
			objects.set(key, new Uint8Array(await request.arrayBuffer()));
			return new Response(null, { status: 200 });
		}
		if (request.method === 'DELETE') {
			if (options.deleteStatus) return new Response('denied', { status: options.deleteStatus });
			objects.delete(key);
			return new Response(null, { status: 204 });
		}
		if (request.method === 'GET' && url.searchParams.has('list-type')) {
			const prefix = url.searchParams.get('prefix') ?? '';
			const contents = [...objects.entries()]
				.filter(([name]) => name.startsWith(prefix))
				.map(
					([name, data]) =>
						`<Contents><Key>${name}</Key><LastModified>2026-01-02T03:04:05.000Z</LastModified><Size>${data.byteLength}</Size></Contents>`,
				)
				.join('');
			return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
		}
		return new Response('missing', { status: 404 });
	}) as typeof fetch;
	return { fetchImpl, calls, objects };
}

const remote = fakeS3();

function s3Input(name: string, extra: Record<string, unknown> = {}) {
	return {
		name,
		kind: 's3' as const,
		endpoint: 'https://s3.example.test',
		bucket: 'backups',
		pathPrefix: 'skiff/backups',
		accessKeyId: 'AKIAEXAMPLE',
		secretAccessKey: secret,
		...extra,
	};
}

describe('backup targets', () => {
	test('seals credentials and never returns them in a view', () => {
		core.ctx.config.storageFetch = remote.fetchImpl;
		const created = core.backupTargets.create(owner, s3Input('org-s3'));
		expect(created.credentials?.secretAccessKey).toBe(secret);
		expect(created.target).toMatchObject({
			orgId: 'org_1',
			name: 'org-s3',
			kind: 's3',
			hasCredentials: true,
			status: 'pending',
			pathPrefix: 'skiff/backups',
		});
		expect(JSON.stringify(created.target)).not.toContain(secret);
		expect(JSON.stringify(core.backupTargets.list(owner))).not.toContain(secret);
		expect(JSON.stringify(core.backupTargets.get(owner, created.target.id))).not.toContain(secret);

		const row = opened.sqlite
			.query<{ access_key_sealed: string; secret_sealed: string }, [string]>(
				'SELECT access_key_sealed, secret_sealed FROM backup_targets WHERE id = ?',
			)
			.get(created.target.id)!;
		expect(row.secret_sealed).not.toContain(secret);
		// It opens with the org key.
		expect(core.secrets.open('org_1', row.secret_sealed)).toBe(secret);

		const audits = opened.sqlite
			.query<{ args_json: string }, []>("SELECT args_json FROM audit_log WHERE action = 'backup-target.create'")
			.all();
		expect(JSON.stringify(audits)).not.toContain(secret);
	});

	test('creates a local target probe that writes and cleans up', async () => {
		const path = join(dir, 'local-backups');
		const created = core.backupTargets.create(owner, { name: 'local-a', kind: 'local', path });
		expect(created.target).toMatchObject({ kind: 'local', path, hasCredentials: false });
		expect(JSON.stringify(created.target)).not.toContain('secretAccessKey');
		const result = await core.backupTargets.testConnection(owner, created.target.id);
		expect(result.ok).toBe(true);
		expect(result.objectLock).toBe(false);
		expect(core.backupTargets.get(owner, created.target.id).status).toBe('ok');
	});

	test('an S3 probe uses the target prefix and reports success', async () => {
		core.ctx.config.storageFetch = remote.fetchImpl;
		const target = core.backupTargets.list(owner).find((row) => row.name === 'org-s3')!;
		const result = await core.backupTargets.testConnection(owner, target.id);
		expect(result.ok).toBe(true);
		expect(result.message).toContain('Connected');
		expect(remote.calls.some((call) => call.includes('skiff/backups/skiff/healthcheck/'))).toBe(true);
	});

	test('database backup tasks use the resolved target store', async () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		core.databases.create(owner, { name: 'backup-db', memoryMb: 128 });
		const backup = core.databases.createBackup(owner, 'backup-db');
		const tasks = await core.databases.backupTasksForNode(joined.nodeId);
		const task = tasks.find((row) => row.id === backup.id)!;
		expect(task.url).toContain('s3.example.test');
		expect(new URL(task.url).pathname).toContain('/skiff/backups/database-backups/');
		// A failed dump left nothing on the target, so it does not hold the target (deleted below).
		core.databases.applyBackupResults(joined.nodeId, [
			{ taskId: backup.id, action: 'backup', databaseId: task.databaseId, backupId: null, status: 'failed', error: 'test' },
		]);
		expect(core.databases.getBackup(owner, 'backup-db', backup.id).target).toMatchObject({
			name: 'org-s3',
			kind: 's3',
			available: true,
			location: expect.stringContaining('s3://backups/skiff/backups/database-backups/'),
		});
	});

	test('resolves resource → org → platform → local default', () => {
		const localOrg = core.backupTargets.create(owner, { name: 'org-local', kind: 'local', path: join(dir, 'x') });
		// Same name is allowed in another org.
		const otherLocal = core.backupTargets.create(other, { name: 'org-local', kind: 'local', path: join(dir, 'y') });

		const named = core.backupTargets.list(owner).find((row) => row.name === 'org-s3')!;
		// The oldest org target is the default; a caller can name a newer one.
		expect(core.backupTargets.resolveTarget('org_1')).toMatchObject({ source: 'org', target: { id: named.id } });
		expect(core.backupTargets.resolveTarget('org_1', localOrg.target.id)).toMatchObject({
			source: 'resource',
			target: { id: localOrg.target.id },
		});
		expect(core.backupTargets.resolveTarget('org_2')).toMatchObject({ source: 'org', target: { id: otherLocal.target.id } });
		expect(() => core.backupTargets.resolveTarget('org_2', named.id)).toThrow(/not found/i);
		core.backupTargets.delete(owner, named.id);
		const probe = core.backupTargets.list(owner).find((row) => row.name === 'local-a')!;
		core.backupTargets.delete(owner, probe.id);
		expect(core.backupTargets.resolveTarget('org_1')).toMatchObject({
			source: 'org',
			target: { id: localOrg.target.id },
		});
		core.backupTargets.delete(owner, localOrg.target.id);

		const platform = core.backupTargets.create(owner, { name: 'platform-local', kind: 'local', path: join(dir, 'p') }, { platform: true });
		expect(core.backupTargets.resolveTarget('org_3')).toMatchObject({
			source: 'platform',
			target: { id: platform.target.id },
		});
		core.backupTargets.delete(owner, platform.target.id);
		expect(core.backupTargets.resolveTarget('org_3')).toMatchObject({ source: 'local', target: { id: 'local-default' } });
	});

	test('a write-only target passes the probe but refuses deletes', async () => {
		const denying = fakeS3({ deleteStatus: 403 });
		core.ctx.config.storageFetch = denying.fetchImpl;
		const created = core.backupTargets.create(owner, s3Input('write-only', { writeOnly: true }));
		const result = await core.backupTargets.testConnection(owner, created.target.id);
		expect(result.ok).toBe(true);
		expect(result.message).toContain('delete denied');
		const target = core.backupTargets.get(owner, created.target.id);
		expect(() => core.backupTargets.assertDeleteAllowed(target)).toThrow(/write-only/);
		expect(core.backupTargets.resolveTarget('org_1', target.id).target.writeOnly).toBe(true);
	});

	test('rejects a non-owner org changing another org target', () => {
		const target = core.backupTargets.list(owner)[0]!;
		expect(() => core.backupTargets.get(other, target.id)).toThrow(/not found/i);
	});
});

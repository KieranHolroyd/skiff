import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { DEFAULT_FEATURES, postgresPitrImage } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-pitr-'));
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-05T10:00:00Z');

const repo = {
	kind: 's3' as const,
	endpoint: 'https://s3.example.test',
	bucket: 'skiff-pitr',
	region: 'us-east-1',
	pathPrefix: 'skiff/pitr',
	forcePathStyle: true,
	accessKeyId: 'access-key',
	secretAccessKey: 'super-secret-key',
};

function makeCore(features: typeof DEFAULT_FEATURES): Core {
	const opened = createDb({ path: ':memory:' });
	const core = createCore({
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
			now: () => clock,
			features,
			pitrRepository: repo,
		},
	});
	return core;
}

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('database PITR (flag on)', () => {
	const core = makeCore({ ...DEFAULT_FEATURES, PITR: true });
	let nodeId = '';
	let token = '';

	test('refuses engines, versions and variants without a pgBackRest image', () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		nodeId = joined.nodeId;
		token = joined.token;
		core.databases.create(owner, { name: 'old-pg', version: '17' });
		expect(() => core.databases.setPitrPolicy(owner, 'old-pg', { enabled: true })).toThrow(/PostgreSQL 18/);
		core.databases.create(owner, { name: 'cache', engine: 'valkey' });
		expect(() => core.databases.setPitrPolicy(owner, 'cache', { enabled: true })).toThrow();
	});

	test('enables the policy, switches to the PITR image and queues the first full backup', async () => {
		core.databases.create(owner, { name: 'main-db', version: '18' });

		const status = core.databases.setPitrPolicy(owner, 'main-db', { enabled: true });
		expect(status).toMatchObject({ enabled: true, status: 'pending', verifiedAt: null, recoverableFrom: null });
		expect(status.nextFullAt).not.toBeNull();
		expect(status.nextDiffAt).not.toBeNull();
		expect(JSON.stringify(status)).not.toContain(repo.secretAccessKey);

		const state = await core.nodes.desiredState(token);
		const workload = state.workloads.find((item) => item.projectSlug === 'main-db')!;
		expect(workload.database?.pitr).toMatchObject({ stanza: status.stanza, archiveTimeoutSeconds: 60 });
		expect(workload.image).toBe(postgresPitrImage('18'));
		expect(state.workloads.find((item) => item.projectSlug === 'old-pg')?.image).not.toContain('pitr');
		expect(JSON.stringify(state)).not.toContain(repo.secretAccessKey);
		const first = state.databasePitrTasks.filter((item) => item.databaseId === workload.id);
		expect(first).toEqual([expect.objectContaining({ action: 'basebackup', baseBackupType: 'full' })]);
	});

	test('refuses a restore before the node has reported a recoverable window', () => {
		expect(() =>
			core.databases.restoreToTimestamp(owner, 'main-db', {
				name: 'too-early',
				targetTime: new Date(clock - 60_000).toISOString(),
			}),
		).toThrow(/no base backup has been reported/);
	});

	test('records the first base backup without leaking credentials and refreshes the window', async () => {
		expect(() => core.databases.pitrBackup(owner, 'main-db')).toThrow(/already queued/);
		const state = await core.nodes.desiredState(token);
		const task = state.databasePitrTasks.find((item) => item.action === 'basebackup' && item.databaseName === 'main_db')!;
		expect(task).toMatchObject({ action: 'basebackup', baseBackupType: 'full', targetDatabaseId: null });
		expect(JSON.stringify(state)).not.toContain(repo.secretAccessKey);

		const activation = core.databases.pitrActivation(nodeId, task.id);
		expect(activation.repo.secretAccessKey).toBe(repo.secretAccessKey);
		expect(() => core.databases.pitrActivation('nod_other', task.id)).toThrow();

		core.databases.applyPitrResults(nodeId, [
			{
				taskId: task.id,
				action: 'basebackup',
				databaseId: task.databaseId,
				targetDatabaseId: null,
				status: 'ok',
				baseBackupType: 'full',
			},
		]);
		const status = core.databases.pitrStatus(owner, 'main-db');
		expect(status).toMatchObject({ status: 'ok', archiveStatus: 'ok', lastBaseBackupType: 'full' });
		expect(status.lastBaseBackupAt).not.toBeNull();
		// A finished backup queues a status check so the window shows up without waiting.
		expect(() => core.databases.pitrBackup(owner, 'main-db', { type: 'diff' })).not.toThrow();
		const after = await core.nodes.desiredState(token);
		const check = after.databasePitrTasks.find((item) => item.action === 'status' && item.databaseId === task.databaseId)!;
		expect(check).toBeDefined();
		core.databases.applyPitrResults(nodeId, [
			{
				taskId: check.id,
				action: 'status',
				databaseId: task.databaseId,
				targetDatabaseId: null,
				status: 'ok',
				archiveStatus: 'ok',
				window: {
					recoverableFrom: clock - 60 * 60_000,
					recoverableTo: clock - 10 * 60_000,
					backupCount: 1,
					newestBackupAt: clock - 60 * 60_000,
					newestBackupType: 'full',
					lastArchivedAt: clock - 10 * 60_000,
					repoMessage: null,
				},
			},
		]);
		expect(core.databases.pitrStatus(owner, 'main-db')).toMatchObject({
			recoverableFrom: new Date(clock - 60 * 60_000).toISOString(),
			recoverableTo: new Date(clock - 10 * 60_000).toISOString(),
			windowCheckedAt: new Date(clock).toISOString(),
			error: null,
		});
	});

	test('validates the restore target against the reported window', () => {
		expect(() =>
			core.databases.restoreToTimestamp(owner, 'main-db', {
				name: 'before-window',
				targetTime: new Date(clock - 2 * 60 * 60_000).toISOString(),
			}),
		).toThrow(/earliest recoverable point/);
		// A healthy archive keeps landing WAL, so the window moves with the clock (minus slack).
		expect(() =>
			core.databases.restoreToTimestamp(owner, 'main-db', {
				name: 'too-fresh',
				targetTime: new Date(clock - 30_000).toISOString(),
			}),
		).toThrow(/latest archived WAL/);
		core.ctx.sqlite.run("UPDATE database_pitr SET archive_status = 'failing'");
		expect(() =>
			core.databases.restoreToTimestamp(owner, 'main-db', {
				name: 'past-archive',
				targetTime: new Date(clock - 5 * 60_000).toISOString(),
			}),
		).toThrow(/latest archived WAL/);
		core.ctx.sqlite.run("UPDATE database_pitr SET archive_status = 'ok'");
	});

	test('restores to a timestamp into a new database and records verified_at', async () => {
		const source = core.databases.get(owner, 'main-db');
		const targetTime = new Date(clock - 5 * 60_000).toISOString();
		const target = core.databases.restoreToTimestamp(owner, 'main-db', {
			name: 'main-pitr',
			targetTime,
		});
		expect(target).toMatchObject({ name: 'main-pitr', status: 'pending' });
		expect(target.id).not.toBe(source.id);
		expect(core.databases.get(owner, 'main-pitr').backup.enabled).toBe(false);
		// The empty target the node starts first must not look restored.
		core.databases.applyHeartbeat(nodeId, [{ id: target.id, status: 'running', restarts: 0 }]);
		expect(core.databases.get(owner, 'main-pitr').status).toBe('pending');

		const state = await core.nodes.desiredState(token);
		const task = state.databasePitrTasks.find((item) => item.action === 'restore')!;
		expect(task).toMatchObject({
			databaseId: source.id,
			targetDatabaseId: target.id,
			targetTime: Date.parse(targetTime),
		});

		core.databases.applyPitrResults(nodeId, [
			{
				taskId: task.id,
				action: 'restore',
				databaseId: source.id,
				targetDatabaseId: target.id,
				status: 'ok',
				targetTime: Date.parse(targetTime),
				verified: true,
			},
		]);
		const status = core.databases.pitrStatus(owner, 'main-db');
		expect(status.verifiedAt).not.toBeNull();
		expect(status.lastRestoreDatabaseId).toBe(target.id);
		const restored = core.databases.get(owner, 'main-pitr');
		expect(restored.backup.lastVerifiedAt).not.toBeNull();
		expect(restored.status).toBe('running');
		// Released: later heartbeats own the status again.
		core.databases.applyHeartbeat(nodeId, [{ id: target.id, status: 'failed', restarts: 0 }]);
		expect(core.databases.get(owner, 'main-pitr').status).toBe('failed');
	});

	test('a failed restore keeps its target failed even if the node starts it empty', async () => {
		const target = core.databases.restoreToTimestamp(owner, 'main-db', {
			name: 'broken-pitr',
			targetTime: new Date(clock - 20 * 60_000).toISOString(),
		});
		const state = await core.nodes.desiredState(token);
		const task = state.databasePitrTasks.find((item) => item.targetDatabaseId === target.id)!;
		core.databases.applyPitrResults(nodeId, [
			{
				taskId: task.id,
				action: 'restore',
				databaseId: task.databaseId,
				targetDatabaseId: target.id,
				status: 'failed',
				error: 'Recovery stopped before reaching the target time',
			},
		]);
		core.databases.applyHeartbeat(nodeId, [{ id: target.id, status: 'running', restarts: 0 }]);
		const failed = core.databases.get(owner, 'broken-pitr');
		expect(failed.status).toBe('failed');
		expect(core.databases.pitrStatus(owner, 'main-db').error).toMatch(/Recovery stopped/);
	});

	test('queues a status check every 15 minutes, never two at once', () => {
		core.ctx.sqlite.run("UPDATE database_pitr_tasks SET status = 'ok' WHERE action = 'status'");
		clock += 15 * 60_000;
		core.databases.tickPitr();
		const pending = () =>
			core.ctx.sqlite
				.query<{ n: number }, []>("SELECT count(*) AS n FROM database_pitr_tasks WHERE action = 'status' AND status = 'pending'")
				.get()!.n;
		expect(pending()).toBe(1);
		clock += 15 * 60_000;
		core.databases.tickPitr();
		expect(pending()).toBe(1);
	});

	test('rejects a future or expired restore target before creating a database', () => {
		expect(() =>
			core.databases.restoreToTimestamp(owner, 'main-db', {
				name: 'future-db',
				targetTime: new Date(clock + 60_000).toISOString(),
			}),
		).toThrow(/future/);
		expect(() =>
			core.databases.restoreToTimestamp(owner, 'main-db', {
				name: 'old-db',
				targetTime: new Date(clock - 40 * 86_400_000).toISOString(),
			}),
		).toThrow(/retention/);
		expect(() => core.databases.get(owner, 'future-db')).toThrow();
	});

	test('uses the scheduler primitive for due full and differential backups', async () => {
		// The manual diff queued above has finished; force the weekly slot due without waiting for Sunday.
		core.ctx.sqlite.run("UPDATE database_pitr_tasks SET status = 'ok' WHERE action = 'basebackup'");
		core.ctx.sqlite.run('UPDATE database_pitr SET next_full_at = ?, next_diff_at = ?', [clock - 1_000, clock - 1_000]);
		expect(core.databases.tickPitr()).toBeGreaterThanOrEqual(1);
		const task = core.ctx.sqlite
			.query<{ action: string; base_backup_type: string }, []>(
				"SELECT action, base_backup_type FROM database_pitr_tasks WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1",
			)
			.get()!;
		expect(task.action).toBe('basebackup');
		expect(['full', 'diff']).toContain(task.base_backup_type);
		const scheduler = core.ctx.sqlite
			.query<{ status: string }, []>(
				"SELECT status FROM scheduled_tasks WHERE kind = 'database.pitr.basebackup'",
			)
			.all();
		expect(scheduler.length).toBeGreaterThan(0);
		expect(scheduler.every((row) => row.status === 'ok')).toBe(true);
	});
});

describe('database PITR (turning it off)', () => {
	const core = makeCore({ ...DEFAULT_FEATURES, PITR: true });

	test('cancels waiting backups and status checks and drops the PITR image', async () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		core.databases.create(owner, { name: 'toggle-db', version: '18' });
		core.databases.setPitrPolicy(owner, 'toggle-db', { enabled: true });
		expect((await core.nodes.desiredState(joined.token)).databasePitrTasks).toHaveLength(1);
		const off = core.databases.setPitrPolicy(owner, 'toggle-db', { enabled: false });
		expect(off.enabled).toBe(false);
		const state = await core.nodes.desiredState(joined.token);
		expect(state.databasePitrTasks).toEqual([]);
		const workload = state.workloads.find((item) => item.projectSlug === 'toggle-db')!;
		expect(workload.database?.pitr).toBeUndefined();
		expect(workload.image).not.toContain('pitr');
	});
});

describe('database PITR (flag off)', () => {
	const core = makeCore({ ...DEFAULT_FEATURES, PITR: false });
	let nodeId = '';

	test('fails closed and never emits tasks or credentials', async () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		nodeId = joined.nodeId;
		core.databases.create(owner, { name: 'off-db', version: '18' });

		expect(() => core.databases.setPitrPolicy(owner, 'off-db', { enabled: true })).toThrow(/disabled/);
		expect(() => core.databases.pitrBackup(owner, 'off-db')).toThrow(/disabled/);
		expect(() =>
			core.databases.restoreToTimestamp(owner, 'off-db', {
				name: 'off-restored',
				targetTime: new Date(clock - 60_000).toISOString(),
			}),
		).toThrow(/disabled/);
		expect(core.databases.tickPitr()).toBe(0);
		expect(await core.databases.pitrTasksForNode(nodeId)).toEqual([]);
		const state = await core.nodes.desiredState(joined.token);
		expect(state.databasePitrTasks).toEqual([]);
		expect(state.workloads.find((item) => item.projectSlug === 'off-db')?.database?.pitr).toBeUndefined();
	});
});

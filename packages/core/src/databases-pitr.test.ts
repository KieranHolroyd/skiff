import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { DEFAULT_FEATURES } from '@skiff/contracts';
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

	test('enables the policy and schedules weekly full / daily diff backups', async () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		nodeId = joined.nodeId;
		token = joined.token;
		core.databases.create(owner, { name: 'main-db' });

		const status = core.databases.setPitrPolicy(owner, 'main-db', { enabled: true });
		expect(status).toMatchObject({ enabled: true, status: 'pending', verifiedAt: null });
		expect(status.nextFullAt).not.toBeNull();
		expect(status.nextDiffAt).not.toBeNull();
		expect(JSON.stringify(status)).not.toContain(repo.secretAccessKey);

		const state = await core.nodes.desiredState(token);
		const workload = state.workloads.find((item) => item.projectSlug === 'main-db')!;
		expect(workload.database?.pitr).toMatchObject({ stanza: status.stanza, archiveTimeoutSeconds: 60 });
		expect(JSON.stringify(state)).not.toContain(repo.secretAccessKey);
	});

	test('queues a base backup and records the node result without leaking credentials', async () => {
		const task = core.databases.pitrBackup(owner, 'main-db', { type: 'full' });
		expect(task).toMatchObject({ action: 'basebackup', baseBackupType: 'full', targetDatabaseId: null });
		expect(() => core.databases.pitrBackup(owner, 'main-db')).toThrow(/already queued/);

		const state = await core.nodes.desiredState(token);
		const wanted = state.databasePitrTasks.find((item) => item.id === task.id)!;
		expect(wanted).toMatchObject({ action: 'basebackup', databaseId: task.databaseId, stanza: task.stanza });
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
	});

	test('uses the scheduler primitive for due full and differential backups', async () => {
		// Force the weekly slot due without waiting for Sunday.
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

describe('database PITR (flag off)', () => {
	const core = makeCore({ ...DEFAULT_FEATURES, PITR: false });
	let nodeId = '';

	test('fails closed and never emits tasks or credentials', async () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		nodeId = joined.nodeId;
		core.databases.create(owner, { name: 'off-db' });

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

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

/**
 * Backups record the target they were written to (0053). Restore, retention, purge and delete use
 * the record, so adding a target or switching the default never strands an existing backup.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-backup-locations-'));
const opened = createDb({ path: ':memory:' });
const platformStore = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
const DAY = 86_400_000;
let clock = Date.parse('2026-11-04T10:00:00Z');

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: platformStore,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const other = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_2', role: 'owner' });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

let nodeId = '';

/** Queue a backup, have the "node" upload it through the presigned task and report ok. */
async function takeBackup(name: string, body: string): Promise<{ id: string; objectKey: string; url: string }> {
	const backup = core.databases.createBackup(owner, name);
	const task = (await core.databases.backupTasksForNode(nodeId)).find((row) => row.id === backup.id)!;
	await storeForUrl(task.url).put(task.objectKey, new TextEncoder().encode(body));
	core.databases.applyBackupResults(nodeId, [
		{ taskId: backup.id, action: 'backup', databaseId: task.databaseId, backupId: null, status: 'ok', sizeBytes: body.length },
	]);
	clock += 60_000;
	return { id: backup.id, objectKey: task.objectKey, url: task.url };
}

/** The store a presigned URL points at: a target route or the platform object store. */
function storeForUrl(url: string): LocalObjectStore {
	const match = /\/api\/backup-targets\/([^/]+)\/objects\//.exec(new URL(url).pathname);
	if (!match) return platformStore;
	return core.backupTargets.localStore(decodeURIComponent(match[1]!))!.store;
}

async function restoreTaskUrl(name: string, backupId: string, as: string): Promise<string> {
	const restored = core.databases.restoreBackup(owner, name, backupId, { name: as });
	const task = (await core.databases.backupTasksForNode(nodeId)).find((row) => row.id === `restore:${restored.id}`)!;
	core.databases.applyBackupResults(nodeId, [
		{ taskId: task.id, action: 'restore', databaseId: restored.id, backupId, status: 'ok' },
	]);
	return task.url;
}

describe('backups remember the target they were written to', () => {
	const pathA = join(dir, 'target-a');
	const pathB = join(dir, 'target-b');
	const ids = { platform: '', a: '', b: '' };
	type Taken = { id: string; objectKey: string; url: string };
	const none: Taken = { id: '', objectKey: '', url: '' };
	const backups: Record<'store' | 'platform' | 'a' | 'b' | 'b2', Taken> = {
		store: none,
		platform: none,
		a: none,
		b: none,
		b2: none,
	};

	test('the platform default, then an org target: each backup records its own target', async () => {
		nodeId = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' }).nodeId;
		core.databases.create(owner, { name: 'orders', memoryMb: 128 });

		// No target yet: the platform object store.
		backups.store = await takeBackup('orders', 'dump-on-platform-store');
		expect(backups.store.url).toContain('/api/objects/');

		// A platform default target applies to every org without one.
		ids.platform = core.backupTargets.create(owner, { name: 'platform', kind: 'local', path: pathB }, { platform: true }).target.id;
		backups.platform = await takeBackup('orders', 'dump-on-platform-target');
		expect(backups.platform.url).toContain(`/api/backup-targets/${ids.platform}/objects/`);

		// The org's own target now wins; the default has switched.
		ids.a = core.backupTargets.create(owner, { name: 'org-a', kind: 'local', path: pathA }).target.id;
		backups.a = await takeBackup('orders', 'dump-on-org-a');
		expect(backups.a.url).toContain(`/api/backup-targets/${ids.a}/objects/`);

		const listed = new Map(core.databases.listBackups(owner, 'orders').map((row) => [row.id, row.target]));
		expect(listed.get(backups.store.id)).toMatchObject({ id: null, kind: 'platform', available: true });
		expect(listed.get(backups.platform.id)).toMatchObject({
			id: ids.platform,
			name: 'platform',
			kind: 'local',
			location: `file://${join(pathB, backups.platform.objectKey)}`,
			available: true,
		});
		expect(listed.get(backups.a.id)).toMatchObject({ id: ids.a, name: 'org-a', available: true });
	});

	test('a restore reads from the recorded target after the default changed', async () => {
		const fromStore = await restoreTaskUrl('orders', backups.store.id, 'orders-r1');
		expect(fromStore).toContain('/api/objects/');
		expect(new TextDecoder().decode(await storeForUrl(fromStore).get(backups.store.objectKey))).toBe('dump-on-platform-store');

		const fromPlatform = await restoreTaskUrl('orders', backups.platform.id, 'orders-r2');
		expect(fromPlatform).toContain(`/api/backup-targets/${ids.platform}/objects/`);
		expect(readFileSync(join(pathB, backups.platform.objectKey), 'utf8')).toBe('dump-on-platform-target');

		const fromA = await restoreTaskUrl('orders', backups.a.id, 'orders-r3');
		expect(fromA).toContain(`/api/backup-targets/${ids.a}/objects/`);
		for (const name of ['orders-r1', 'orders-r2', 'orders-r3']) core.databases.delete(owner, name);
	});

	test('a target holding retained backups cannot be deleted or re-pointed', () => {
		expect(() => core.backupTargets.delete(owner, ids.a)).toThrow(/still holds 1 database backup/);
		expect(() => core.backupTargets.update(owner, ids.a, { path: join(dir, 'elsewhere') })).toThrow(/cannot change/);
		// Renaming and toggling write-only do not move anything.
		expect(core.backupTargets.update(owner, ids.a, { name: 'org-a2' }).target.name).toBe('org-a2');
		// Another org cannot see, so cannot delete, this org's target.
		expect(() => core.backupTargets.delete(other, ids.a)).toThrow(/not found/i);
	});

	test('retention deletes each object from its recorded target and keeps the newest', async () => {
		expect(existsSync(join(pathB, backups.platform.objectKey))).toBe(true);
		expect(await platformStore.exists(backups.store.objectKey)).toBe(true);
		clock += 30 * DAY;
		const removed = await core.databases.pruneBackups();
		expect(removed).toBe(2);
		expect(await platformStore.exists(backups.store.objectKey)).toBe(false);
		expect(existsSync(join(pathB, backups.platform.objectKey))).toBe(false);
		// The newest good backup survives even past its expiry.
		expect(existsSync(join(pathA, backups.a.objectKey))).toBe(true);
		expect(core.databases.listBackups(owner, 'orders').map((row) => row.id)).toEqual([backups.a.id]);
		// The platform target no longer holds anything, so it can go.
		expect(core.backupTargets.delete(owner, ids.platform)).toEqual({ unavailableBackups: 0 });
	});

	test('a forced delete marks backups unavailable; re-adding the location reconnects them', async () => {
		// org-a is the oldest org target; org-b only becomes the default once org-a is gone.
		ids.b = core.backupTargets.create(owner, { name: 'org-b', kind: 'local', path: pathB }).target.id;
		expect(core.backupTargets.delete(owner, ids.a, { force: true })).toEqual({ unavailableBackups: 1 });

		const gone = core.databases.getBackup(owner, 'orders', backups.a.id);
		expect(gone.target).toMatchObject({ id: ids.a, name: 'org-a2', available: false });
		expect(gone.target.unavailableReason).toContain('has been deleted');
		expect(gone.target.unavailableReason).toContain(join(pathA, backups.a.objectKey));
		expect(() => core.databases.restoreBackup(owner, 'orders', backups.a.id, { name: 'orders-r4' })).toThrow(
			/has been deleted/,
		);
		expect(core.databases.list(owner).some((db) => db.name === 'orders-r4')).toBe(false);

		// New backups go to org-b; the unreachable one is never pruned and never counts as newest.
		backups.b = await takeBackup('orders', 'dump-on-org-b');
		expect(backups.b.url).toContain(`/api/backup-targets/${ids.b}/objects/`);
		backups.b2 = await takeBackup('orders', 'dump-on-org-b-2');
		clock += 30 * DAY;
		expect(await core.databases.pruneBackups()).toBe(1);
		expect(existsSync(join(pathB, backups.b.objectKey))).toBe(false);
		expect(core.databases.listBackups(owner, 'orders').map((row) => row.id).sort()).toEqual(
			[backups.a.id, backups.b2.id].sort(),
		);
		expect(existsSync(join(pathA, backups.a.objectKey))).toBe(true);

		// Another org adding the same directory adopts nothing.
		core.backupTargets.create(other, { name: 'theirs', kind: 'local', path: pathA });
		expect(core.databases.getBackup(owner, 'orders', backups.a.id).target.available).toBe(false);

		// Adding a target with the same location reconnects it.
		const again = core.backupTargets.create(owner, { name: 'org-a-again', kind: 'local', path: pathA }).target.id;
		const back = core.databases.getBackup(owner, 'orders', backups.a.id);
		expect(back.target).toMatchObject({ id: again, name: 'org-a-again', available: true });
		const url = await restoreTaskUrl('orders', backups.a.id, 'orders-r5');
		expect(url).toContain(`/api/backup-targets/${again}/objects/`);
		core.databases.delete(owner, 'orders-r5');
	});

	test('deleting a backup whose target is gone drops the row and leaves the object', async () => {
		const ownerTargets = core.backupTargets.list(owner).filter((row) => row.orgId === 'org_1');
		const again = ownerTargets.find((row) => row.name === 'org-a-again')!;
		expect(() => core.backupTargets.delete(owner, again.id)).toThrow(/still holds/);
		core.backupTargets.delete(owner, again.id, { force: true });
		await core.databases.deleteBackup(owner, 'orders', backups.a.id);
		expect(existsSync(join(pathA, backups.a.objectKey))).toBe(true);
		expect(core.databases.listBackups(owner, 'orders').map((row) => row.id)).toEqual([backups.b2.id]);
		const audit = opened.sqlite
			.query<{ args_json: string }, []>(
				"SELECT args_json FROM audit_log WHERE action = 'database.backup-delete' ORDER BY rowid DESC LIMIT 1",
			)
			.get()!;
		expect(JSON.parse(audit.args_json)).toMatchObject({ objectDeleted: false, targetId: again.id });
	});

	test('force refuses while a backup on the target is still in flight', async () => {
		const pending = core.databases.createBackup(owner, 'orders');
		expect(() => core.backupTargets.delete(owner, ids.b, { force: true })).toThrow(/in progress/);
		const task = (await core.databases.backupTasksForNode(nodeId)).find((row) => row.id === pending.id)!;
		core.databases.applyBackupResults(nodeId, [
			{ taskId: task.id, action: 'backup', databaseId: task.databaseId, backupId: null, status: 'failed', error: 'x' },
		]);
	});

	test('a pending backup whose recorded target vanished fails instead of hanging', async () => {
		const pending = core.databases.createBackup(owner, 'orders');
		// Simulate a target row removed out of band.
		opened.sqlite.query('UPDATE database_backups SET target_id = ? WHERE id = ?').run('bt_missing', pending.id);
		const tasks = await core.databases.backupTasksForNode(nodeId);
		expect(tasks.some((row) => row.id === pending.id)).toBe(false);
		const failed = core.databases.getBackup(owner, 'orders', pending.id);
		expect(failed.status).toBe('failed');
		expect(failed.error).toContain('has been deleted');
	});
});

describe('0053 backfill and legacy rows', () => {
	test('backfills existing rows with the target that resolves for their org today', () => {
		const sqlPath = join(import.meta.dir, '../../db/migrations/0053_backup_locations.sql');
		const updates = readFileSync(sqlPath, 'utf8')
			.split(';')
			.map((part) => part.replace(/^\s*--.*$/gm, '').trim())
			.filter((part) => part.startsWith('UPDATE'));
		expect(updates).toHaveLength(2);

		const insert = opened.sqlite.query(
			`INSERT INTO database_backups (id, org_id, database_id, kind, status, object_key, created_by, created_at)
			 VALUES (?, ?, 'db_legacy', 'manual', 'ok', ?, 'system', 0)`,
		);
		insert.run('bkp_legacy_org1', 'org_1', 'database-backups/org_1/db_legacy/bkp_legacy_org1.dump');
		insert.run('bkp_legacy_org3', 'org_3', 'database-backups/org_3/db_legacy/bkp_legacy_org3.dump');
		for (const statement of updates) opened.sqlite.run(statement);

		const rows = opened.sqlite
			.query<{ id: string; target_id: string | null; target_name: string; location_json: string }, []>(
				"SELECT id, target_id, target_name, location_json FROM database_backups WHERE id LIKE 'bkp_legacy_%' ORDER BY id",
			)
			.all();
		const org1 = core.backupTargets.resolveTarget('org_1');
		expect(rows[0]).toMatchObject({ id: 'bkp_legacy_org1', target_id: org1.target.id, target_name: org1.target.name });
		expect(JSON.parse(rows[0]!.location_json)).toMatchObject({
			kind: 'local',
			orgId: 'org_1',
			path: org1.target.path,
			pathPrefix: '',
		});
		// org_3 has no target and there is no platform target left: the platform object store.
		expect(rows[1]).toMatchObject({ id: 'bkp_legacy_org3', target_id: null, target_name: 'platform object store' });
		expect(JSON.parse(rows[1]!.location_json)).toEqual({ kind: 'platform' });
		opened.sqlite.run("DELETE FROM database_backups WHERE id LIKE 'bkp_legacy_%'");
	});

	test('a row with no recorded location falls back to the current resolution', () => {
		const view = core.backupTargets.describeRecorded({
			orgId: 'org_3',
			objectKey: 'database-backups/org_3/db/bkp.dump',
			targetId: null,
			targetName: null,
			locationJson: null,
		});
		expect(view).toMatchObject({ id: null, kind: 'platform', available: true });
		expect(view.location).toContain('database-backups/org_3/db/bkp.dump');
	});
});

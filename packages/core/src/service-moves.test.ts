import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { DEFAULT_FEATURES, type Heartbeat } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { MOVE_QUIESCE_TIMEOUT_MS } from './service-moves.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-moves-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-06T10:00:00Z');

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
		// Moves cover the pinned path: process apps follow their database and storage.
		features: { ...DEFAULT_FEATURES, SERVICE_ENDPOINTS: false },
		now: () => clock,
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const join_ = (name: string, publicAddress?: string) =>
	core.nodes.join({ token: core.nodes.createJoinToken(owner, name).token, name, ...(publicAddress ? { publicAddress } : {}) });
const edge = join_('edge');
const alpha = join_('alpha', '10.88.0.2:8080');
const beta = join_('beta', '10.88.0.3:8080');

function beat(node: { nodeId: string; token: string }, extra: Partial<Heartbeat> = {}): void {
	core.nodes.heartbeat(node.token, {
		nodeId: node.nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: core.nodes.stateVersion(),
		status: 'online',
		caddyOk: true,
		releases: [],
		...extra,
	});
}
for (const node of [alpha, beta]) core.nodes.update(owner, node.nodeId, { sliceMemoryMb: 4096 });
for (const node of [edge, alpha, beta]) beat(node);

async function processApp(slug: string, placement: string) {
	await core.projects.create(owner, {
		name: slug,
		slug,
		runtime: 'process',
		placement,
		productionAccess: 'public',
		previewAccess: 'platform',
	});
	const project = core.projects.requireRow(owner, slug);
	await core.uploads.deployInline(owner, project, [file('index.js', 'x'), file('package.json', '{}')], { promote: true });
	return core.projects.requireRow(owner, slug);
}

const workloadOf = (projectId: string) =>
	opened.sqlite.query<{ id: string; nodeId: string }, [string]>('SELECT id, node_id AS nodeId FROM workloads WHERE project_id = ?').get(projectId)!;
const portOf = (name: string) => core.databases.get(owner, name).internalHost.process.split(':')[1];
const moveRow = (databaseId: string) =>
	opened.sqlite
		.query<{ phase: string; outcome: string | null; purgeNodeId: string | null; backupId: string | null }, [string]>(
			'SELECT phase, outcome, purge_node_id AS purgeNodeId, backup_id AS backupId FROM database_moves WHERE database_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
		)
		.get(databaseId)!;

describe('moving an app', () => {
	test('re-points the workload, its deployments and its placement at the target', async () => {
		const project = await processApp('web', alpha.nodeId);
		expect(workloadOf(project.id).nodeId).toBe(alpha.nodeId);

		const result = core.moves.moveApp(owner, 'web', { node: beta.nodeId });
		expect(result).toMatchObject({ project: 'web', from: { name: 'alpha' }, to: { name: 'beta' } });
		expect(workloadOf(project.id).nodeId).toBe(beta.nodeId);
		expect(core.projects.requireRow(owner, 'web').placement).toBe(beta.nodeId);
		const deploymentNodes = opened.sqlite
			.query<{ nodeId: string }, [string]>('SELECT DISTINCT node_id AS nodeId FROM deployments WHERE project_id = ?')
			.all(project.id);
		expect(deploymentNodes).toEqual([{ nodeId: beta.nodeId }]);

		const onBeta = (await core.nodes.desiredState(beta.token)).workloads.map((item) => item.projectSlug);
		const onAlpha = (await core.nodes.desiredState(alpha.token)).workloads.map((item) => item.projectSlug);
		expect(onBeta).toContain('web');
		expect(onAlpha).not.toContain('web');
		expect(core.audit.list({ principal: owner, limit: 5, action: 'project.move' }).map((entry) => entry.resourceId)).toContain(project.id);
	});

	test('refuses static sites, the current node and offline targets', async () => {
		await core.projects.create(owner, {
			name: 'site',
			slug: 'site',
			runtime: 'static',
			placement: 'edge',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		expect(() => core.moves.moveApp(owner, 'site', { node: beta.nodeId })).toThrow(/static site/);
		expect(() => core.moves.moveApp(owner, 'web', { node: beta.nodeId })).toThrow(/already runs/);
		core.nodes.setDraining(owner, alpha.nodeId, true);
		expect(() => core.moves.moveApp(owner, 'web', { node: alpha.nodeId })).toThrow(/draining/);
		core.nodes.setDraining(owner, alpha.nodeId, false);
	});
});

describe('moving a database', () => {
	let dbId = '';
	let appId = '';

	test('stops attached apps, waits for the source, then takes the final dump there', async () => {
		const db = core.databases.create(owner, { name: 'orders', placement: alpha.nodeId });
		dbId = db.id;
		const project = await processApp('shop', 'auto');
		core.databases.attach(owner, project, { database: 'orders' });
		await core.uploads.deployInline(owner, project, [file('index.js', 'y'), file('package.json', '{}')], { promote: true });
		appId = project.id;
		expect(workloadOf(appId).nodeId).toBe(alpha.nodeId);
		const credential = core.databases.createCredential(owner, 'orders', { role: 'readonly' });
		core.databases.applyCredentialResults(alpha.nodeId, [{ taskId: credential.id, databaseId: dbId, status: 'ok' }]);
		core.databases.applyHeartbeat(alpha.nodeId, [{ id: dbId, status: 'running', restarts: 0 }]);

		const move = core.moves.moveDatabase(owner, 'orders', { node: beta.nodeId });
		expect(move).toMatchObject({ phase: 'quiescing', source: { name: 'alpha' }, target: { name: 'beta' }, projects: ['shop'] });
		expect(core.databases.get(owner, 'orders').message).toMatch(/stopping attached apps/);

		// The app stays listed, stopped, so the agent keeps its state; deploys and other changes wait.
		const alphaState = await core.nodes.desiredState(alpha.token);
		expect(alphaState.workloads.find((item) => item.projectSlug === 'shop')?.status).toBe('stopped');
		expect(alphaState.databaseBackupTasks ?? []).toEqual([]);
		expect(() => core.databases.restart(owner, 'orders')).toThrow(/is moving/);
		await expect(
			core.uploads.deployInline(owner, core.projects.requireRow(owner, 'shop'), [file('index.js', 'z'), file('package.json', '{}')], {
				promote: true,
			}),
		).rejects.toThrow(/stopped while a database it uses moves/);

		// An older converge, or the app still reported, keeps the move waiting.
		const appWorkload = workloadOf(appId).id;
		beat(alpha, { actualStateVersion: 1 });
		beat(alpha, { workloads: [{ id: appWorkload, status: 'running', restarts: 0 }] });
		expect(moveRow(dbId).phase).toBe('quiescing');

		beat(alpha, { workloads: [{ id: dbId, status: 'running', restarts: 0 }] });
		expect(moveRow(dbId).phase).toBe('dumping');
		const tasks = (await core.nodes.desiredState(alpha.token)).databaseBackupTasks ?? [];
		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toMatchObject({ action: 'backup', databaseId: dbId, id: moveRow(dbId).backupId });
	});

	test('a good dump re-points the database at the target, which restores it into a fresh instance', async () => {
		const { backupId } = moveRow(dbId);
		const before = core.databases.get(owner, 'orders');
		beat(alpha, {
			databaseBackupResults: [
				{ taskId: backupId!, action: 'backup', databaseId: dbId, backupId: null, status: 'ok', sizeBytes: 1234 },
			],
		});
		expect(moveRow(dbId).phase).toBe('restoring');
		const moved = core.databases.get(owner, 'orders');
		expect(moved.nodeId).toBe(beta.nodeId);
		expect(moved.status).toBe('pending');
		expect(moved.message).toMatch(/restoring/);

		const betaState = await core.nodes.desiredState(beta.token);
		expect(betaState.workloads.map((item) => item.id)).toContain(dbId);
		expect(betaState.databaseBackupTasks?.find((task) => task.action === 'restore')).toMatchObject({
			databaseId: dbId,
			backupId,
		});
		// The source drops the unit but is not told to purge yet: its copy is the rollback.
		const alphaState = await core.nodes.desiredState(alpha.token);
		expect(alphaState.workloads.map((item) => item.id)).not.toContain(dbId);
		expect(alphaState.databasePurges ?? []).not.toContain(dbId);
		expect(before.internalHost.process).toBe('127.0.0.1:15432');
	});

	test('a good restore moves the apps, re-grants named credentials and purges the source copy', async () => {
		beat(beta, {
			databaseBackupResults: [
				{ taskId: `restore:${dbId}`, action: 'restore', databaseId: dbId, backupId: moveRow(dbId).backupId, status: 'ok' },
			],
		});
		expect(moveRow(dbId)).toMatchObject({ phase: 'purging', outcome: 'moved', purgeNodeId: alpha.nodeId });
		const db = core.databases.get(owner, 'orders');
		expect(db.message).toBeNull();
		expect(workloadOf(appId).nodeId).toBe(beta.nodeId);
		expect((await core.nodes.desiredState(beta.token)).workloads.find((item) => item.projectSlug === 'shop')?.status).not.toBe(
			'stopped',
		);
		expect(core.databases.credentialTasksForNode(beta.nodeId).map((task) => task.role)).toEqual(['readonly']);
		expect((await core.nodes.desiredState(alpha.token)).databasePurges).toContain(dbId);

		// The app's activation now points at the target's port.
		const activation = core.workloads.activation(beta.nodeId, workloadOf(appId).id);
		expect(activation.env.DATABASE_PORT).toBe(portOf('orders'));

		beat(alpha, { purgedDatabases: [dbId] });
		expect(moveRow(dbId).phase).toBe('done');
		// The row survives: an ordinary purge would have deleted it.
		expect(core.databases.get(owner, 'orders').nodeId).toBe(beta.nodeId);
		expect(core.moves.latestForDatabase(owner, 'orders')).toMatchObject({ phase: 'done', outcome: 'moved' });
	});

	test('a failed restore rolls back to the source and purges the target copy', async () => {
		core.databases.applyHeartbeat(beta.nodeId, [{ id: dbId, status: 'running', restarts: 0 }]);
		// The target applies the re-granted credential before the next move can start.
		core.databases.applyCredentialResults(
			beta.nodeId,
			core.databases.credentialTasksForNode(beta.nodeId).map((task) => ({ taskId: task.id, databaseId: task.databaseId, status: 'ok' as const })),
		);
		const sourcePort = portOf('orders');
		core.moves.moveDatabase(owner, 'orders', { node: alpha.nodeId });
		beat(beta);
		const { backupId } = moveRow(dbId);
		beat(beta, {
			databaseBackupResults: [{ taskId: backupId!, action: 'backup', databaseId: dbId, backupId: null, status: 'ok' }],
		});
		expect(core.databases.get(owner, 'orders').nodeId).toBe(alpha.nodeId);
		// A database created on the source meanwhile cannot take the port a rollback needs.
		core.databases.create(owner, { name: 'squatter', placement: beta.nodeId, pooler: false });
		expect(portOf('squatter')).not.toBe(sourcePort);

		beat(alpha, {
			databaseBackupResults: [
				{ taskId: `restore:${dbId}`, action: 'restore', databaseId: dbId, backupId, status: 'failed', error: 'disk full' },
			],
		});
		expect(moveRow(dbId)).toMatchObject({ phase: 'purging', outcome: 'rolled_back', purgeNodeId: alpha.nodeId });
		const db = core.databases.get(owner, 'orders');
		expect(db.nodeId).toBe(beta.nodeId);
		expect(portOf('orders')).toBe(sourcePort);
		expect(db.message).toMatch(/rolled back.*disk full/);
		expect(workloadOf(appId).nodeId).toBe(beta.nodeId);
		expect((await core.nodes.desiredState(alpha.token)).databasePurges).toContain(dbId);
		expect((await core.nodes.desiredState(beta.token)).databasePurges ?? []).not.toContain(dbId);
		expect(core.audit.list({ principal: owner, limit: 5, action: 'database.move-failed' }).every((entry) => entry.result === 'error')).toBe(true);
		beat(alpha, { purgedDatabases: [dbId] });
		expect(moveRow(dbId).phase).toBe('done');
	});

	test('a failed final dump or a stuck quiesce gives up without moving anything', async () => {
		core.databases.applyHeartbeat(beta.nodeId, [{ id: dbId, status: 'running', restarts: 0 }]);
		core.moves.moveDatabase(owner, 'orders', { node: alpha.nodeId });
		beat(beta);
		const { backupId } = moveRow(dbId);
		beat(beta, {
			databaseBackupResults: [
				{ taskId: backupId!, action: 'backup', databaseId: dbId, backupId: null, status: 'failed', error: 'pg_dump died' },
			],
		});
		expect(moveRow(dbId).phase).toBe('failed');
		expect(core.databases.get(owner, 'orders')).toMatchObject({ nodeId: beta.nodeId });
		expect(core.databases.get(owner, 'orders').message).toBeNull();
		expect(core.moves.latestForDatabase(owner, 'orders')).toMatchObject({ phase: 'failed', error: expect.stringMatching(/final backup failed.*pg_dump died/) });
		expect((await core.nodes.desiredState(beta.token)).workloads.find((item) => item.projectSlug === 'shop')?.status).not.toBe(
			'stopped',
		);

		core.moves.moveDatabase(owner, 'orders', { node: alpha.nodeId });
		expect(moveRow(dbId).phase).toBe('quiescing');
		clock += MOVE_QUIESCE_TIMEOUT_MS + 1;
		expect(core.moves.tick()).toBe(1);
		expect(moveRow(dbId).phase).toBe('failed');
		expect(core.moves.latestForDatabase(owner, 'orders')?.error).toMatch(/did not stop/);
	});

	test('refuses PITR databases and apps with other pins', async () => {
		// Every engine has native backups now (Valkey included), so none is refused for lacking them.
		const cache = core.databases.create(owner, { name: 'cache', engine: 'valkey', placement: alpha.nodeId });
		expect(cache.capabilities.backups).toBe(true);

		const other = core.databases.create(owner, { name: 'ledger', placement: beta.nodeId });
		core.databases.applyHeartbeat(beta.nodeId, [{ id: other.id, status: 'running', restarts: 0 }]);
		core.databases.attach(owner, core.projects.requireRow(owner, 'shop'), { database: 'ledger', envPrefix: 'LEDGER' });
		expect(() => core.moves.moveDatabase(owner, 'ledger', { node: beta.nodeId })).toThrow(/already runs/);
		// The app also uses "orders" on beta: the move goes ahead and says what stays behind.
		const split = core.moves.moveDatabase(owner, 'ledger', { node: alpha.nodeId });
		expect(split.warnings).toEqual([expect.stringMatching(/"shop" also uses database "orders", which stays where it is/)]);

		opened.sqlite.run(
			`INSERT INTO database_pitr (database_id, org_id, enabled, stanza, repo_json, created_at, updated_at)
			 VALUES (?, 'org_1', 1, 'orders', '{}', ?, ?)`,
			[dbId, clock, clock],
		);
		expect(() => core.moves.moveDatabase(owner, 'orders', { node: alpha.nodeId })).toThrow(/point-in-time recovery/);
		// An app pinned by its database moves with the database, not on its own.
		expect(() => core.moves.moveApp(owner, 'shop', { node: alpha.nodeId })).toThrow(/stopped while its database moves|Move the database instead/);
	});

	test('a node a move still needs cannot be removed', () => {
		const db = core.databases.get(owner, 'squatter');
		core.databases.applyHeartbeat(beta.nodeId, [{ id: db.id, status: 'running', restarts: 0 }]);
		core.moves.moveDatabase(owner, 'squatter', { node: alpha.nodeId });
		expect(core.nodes.removalBlockers(alpha.nodeId).join(' ')).toMatch(/database moves in progress \([^)]*"squatter"/);
	});
});

describe('moving a database that cannot run', () => {
	let dbId = '';
	const failed = () => core.databases.applyHeartbeat(alpha.nodeId, [{ id: dbId, status: 'failed', restarts: 0 }]);

	test('a failed database cannot be dumped, so the error names the two explicit choices', () => {
		const db = core.databases.create(owner, { name: 'archive', placement: alpha.nodeId });
		dbId = db.id;
		core.databases.applyHeartbeat(alpha.nodeId, [{ id: dbId, status: 'running', restarts: 0 }]);
		// A running database must use a dump: the other sources would throw writes away.
		expect(() => core.moves.moveDatabase(owner, 'archive', { node: beta.nodeId, from: 'empty' })).toThrow(/final dump keeps every write/);
		failed();
		expect(() => core.moves.moveDatabase(owner, 'archive', { node: beta.nodeId })).toThrow(
			/it is failed, so it cannot be dumped.*latest-backup.*empty/,
		);
		expect(() => core.moves.moveDatabase(owner, 'archive', { node: beta.nodeId, from: 'latest-backup' })).toThrow(
			/no completed backup/,
		);
	});

	test('"empty" starts it fresh on the target at once and purges the old copy', async () => {
		const move = core.moves.moveDatabase(owner, 'archive', { node: beta.nodeId, from: 'empty' });
		expect(move).toMatchObject({ from: 'empty', phase: 'purging', outcome: 'moved' });
		const db = core.databases.get(owner, 'archive');
		expect(db.nodeId).toBe(beta.nodeId);
		expect(db.status).toBe('pending');
		expect((await core.nodes.desiredState(beta.token)).databaseBackupTasks?.some((task) => task.databaseId === dbId)).toBe(false);
		expect((await core.nodes.desiredState(alpha.token)).databasePurges).toContain(dbId);
		beat(alpha, { purgedDatabases: [dbId] });
		expect(moveRow(dbId).phase).toBe('done');
	});

	test('"latest-backup" restores the newest good backup, even with the old node offline', async () => {
		core.databases.applyHeartbeat(beta.nodeId, [{ id: dbId, status: 'running', restarts: 0 }]);
		const older = core.databases.createBackup(owner, 'archive');
		beat(beta, { databaseBackupResults: [{ taskId: older.id, action: 'backup', databaseId: dbId, backupId: null, status: 'ok' }] });
		clock += 60_000;
		const newer = core.databases.createBackup(owner, 'archive');
		beat(beta, { databaseBackupResults: [{ taskId: newer.id, action: 'backup', databaseId: dbId, backupId: null, status: 'ok' }] });
		// A queued dump on a database that cannot run would never start.
		const stuck = core.databases.createBackup(owner, 'archive');
		core.databases.applyHeartbeat(beta.nodeId, [{ id: dbId, status: 'failed', restarts: 0 }]);
		core.nodes.setDraining(owner, beta.nodeId, true);

		expect(() => core.moves.moveDatabase(owner, 'archive', { node: alpha.nodeId })).toThrow(/cannot be dumped|cannot take a final dump/);
		const move = core.moves.moveDatabase(owner, 'archive', { node: alpha.nodeId, from: 'latest-backup' });
		expect(move).toMatchObject({ from: 'latest-backup', phase: 'restoring', backupId: newer.id });
		expect(core.databases.getBackup(owner, 'archive', stuck.id).status).toBe('failed');
		const restore = (await core.nodes.desiredState(alpha.token)).databaseBackupTasks?.find((task) => task.databaseId === dbId);
		expect(restore).toMatchObject({ action: 'restore', backupId: newer.id });

		beat(alpha, {
			databaseBackupResults: [{ taskId: `restore:${dbId}`, action: 'restore', databaseId: dbId, backupId: newer.id, status: 'ok' }],
		});
		expect(moveRow(dbId)).toMatchObject({ phase: 'purging', outcome: 'moved', purgeNodeId: beta.nodeId });
		expect(core.databases.get(owner, 'archive').nodeId).toBe(alpha.nodeId);
		core.nodes.setDraining(owner, beta.nodeId, false);
	});
});

test('a running database refuses an empty move and points at a final dump', () => {
	const cache = core.databases.get(owner, 'cache');
	core.databases.applyHeartbeat(alpha.nodeId, [{ id: cache.id, status: 'running', restarts: 0 }]);
	expect(() => core.moves.moveDatabase(owner, 'cache', { node: beta.nodeId, from: 'empty' })).toThrow(
		/final dump keeps every write/,
	);
	expect(core.databases.get(owner, 'cache').nodeId).toBe(alpha.nodeId);
});

describe('an app using a database and private storage on the old node', () => {
	test('either service can move first; the app follows and is whole once both have moved', async () => {
		const db = core.databases.create(owner, { name: 'notes-db', placement: alpha.nodeId, pooler: false });
		const store = core.storage.create(owner, { name: 'notes-files', placement: alpha.nodeId, buckets: ['uploads'] });
		const project = await processApp('notes', 'auto');
		core.databases.attach(owner, project, { database: 'notes-db' });
		core.storage.attach(owner, core.projects.requireRow(owner, 'notes'), { storage: 'notes-files', grants: [{ bucket: 'uploads' }] });
		await core.uploads.deployInline(owner, core.projects.requireRow(owner, 'notes'), [file('index.js', 'n'), file('package.json', '{}')], {
			promote: true,
		});
		expect(workloadOf(project.id).nodeId).toBe(alpha.nodeId);
		core.databases.applyHeartbeat(alpha.nodeId, [{ id: db.id, status: 'failed', restarts: 0 }]);

		// Storage only moves empty: objects are not copied.
		expect(() => core.moves.moveStorage(owner, 'notes-files', { node: beta.nodeId })).toThrow(/can only move empty/);
		// Storage first: the app stays with its database and is told why.
		const storageMove = core.moves.moveStorage(owner, 'notes-files', { node: beta.nodeId, from: 'empty' });
		expect(storageMove).toMatchObject({ storage: 'notes-files', to: { name: 'beta' }, projects: [] });
		expect(storageMove.warnings).toEqual([expect.stringMatching(/"notes" stays on alpha with database "notes-db"/)]);
		expect(workloadOf(project.id).nodeId).toBe(alpha.nodeId);
		const betaState = await core.nodes.desiredState(beta.token);
		expect(betaState.workloads.map((item) => item.id)).toContain(store.id);
		expect((await core.nodes.desiredState(alpha.token)).storagePurges).toContain(store.id);
		// A split project cannot deploy until it is whole again.
		await expect(
			core.uploads.deployInline(owner, core.projects.requireRow(owner, 'notes'), [file('index.js', 'n2'), file('package.json', '{}')], {
				promote: true,
			}),
		).rejects.toThrow(/different nodes/);

		// Then the database (down, so empty): the app follows, and nothing is left behind.
		const dbMove = core.moves.moveDatabase(owner, 'notes-db', { node: beta.nodeId, from: 'empty' });
		expect(dbMove.warnings).toEqual([]);
		expect(workloadOf(project.id).nodeId).toBe(beta.nodeId);
		expect(core.workloads.attachmentNode(project.id)).toBe(beta.nodeId);
		const activation = core.workloads.activation(beta.nodeId, workloadOf(project.id).id);
		expect(activation.env.S3_ENDPOINT_URL).toBeDefined();
		expect(activation.env.S3_ACCESS_KEY_ID).toMatch(/^SKF/);

		// Alpha confirms the old copies are gone; the storage row lives on.
		beat(alpha, { purgedStorage: [store.id], purgedDatabases: [db.id] });
		expect((await core.nodes.desiredState(alpha.token)).storagePurges ?? []).not.toContain(store.id);
		expect(core.storage.get(owner, 'notes-files').nodeId).toBe(beta.nodeId);
	});
});

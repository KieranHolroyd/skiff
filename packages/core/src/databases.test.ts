import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { databaseAlias } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { TelemetryStore } from './telemetry.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-databases-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-04T10:00:00Z');

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
		now: () => clock,
	},
});
const telemetry = new TelemetryStore({ path: ':memory:', now: () => clock });
core.ctx.telemetry = telemetry;

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const deployerAgent = buildPrincipal({
	kind: 'mcp',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	granted: ['database:read', 'database:create'],
});
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });

afterAll(async () => {
	await telemetry.close();
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('managed databases', () => {
	let edgeToken = '';
	let edgeId = '';

	test('creates a postgres database on the edge with a loopback port', async () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		edgeToken = joined.token;
		edgeId = joined.nodeId;

		const db = core.databases.create(owner, { name: 'main-db' });
		expect(db).toMatchObject({
			name: 'main-db',
			engine: 'postgres',
			version: '17',
			nodeId: edgeId,
			memoryMb: 256,
			status: 'pending',
			username: 'main_db',
			databaseName: 'main_db',
			internalHost: { process: '127.0.0.1:15432', container: `${databaseAlias(db.id)}:5432` },
			pooler: {
				enabled: true,
				port: 16432,
				host: {
					process: '127.0.0.1:16432',
					container: `${databaseAlias(db.id)}-pool:6432`,
				},
			},
		});
		expect(JSON.stringify(db)).not.toContain('password');
		expect(core.databases.create(owner, { name: 'second' }).internalHost.process).toBe('127.0.0.1:15433');
	});

	test('rejects duplicate and reserved names', () => {
		expect(() => core.databases.create(owner, { name: 'main-db' })).toThrow(/already exists/);
		expect(() => core.databases.create(owner, { name: 'pg-stuff' })).toThrow(/pg-/);
	});

	test('databases reserve slice memory alongside workloads', () => {
		const capacity = core.workloads.capacity(owner).find((row) => row.nodeId === edgeId);
		expect(capacity?.reservedMemoryMb).toBe(512);
		expect(capacity?.workloadCount).toBe(2);
		expect(() => core.databases.update(owner, 'second', { memoryMb: 900 })).toThrow(/budget/);
		expect(core.databases.update(owner, 'second', { memoryMb: 128 }).memoryMb).toBe(128);
	});

	test('desired state carries the database profile but never its password', async () => {
		const state = await core.nodes.desiredState(edgeToken);
		const entry = state.workloads.find((workload) => workload.projectSlug === 'main-db');
		expect(entry).toMatchObject({
			runtime: 'container',
			image: 'docker.io/library/postgres:17-alpine',
			port: 15432,
			upstream: '127.0.0.1:15432',
			database: { engine: 'postgres', version: '17' },
			pooler: { port: 16432 },
			env: { POSTGRES_USER: 'main_db', POSTGRES_DB: 'main_db', PGDATA: '/data/pgdata' },
		});
		const creds = core.databases.credentials(owner, 'main-db');
		expect(JSON.stringify(state)).not.toContain(creds.password);

		const activation = core.workloads.activation(edgeId, entry!.id);
		expect(activation.activationVersion).toBe(entry!.activationVersion);
		expect(activation.env.POSTGRES_PASSWORD).toBe(creds.password);
		expect(activation.monitor).toMatchObject({ monitorUser: 'skiff_monitor', ownerUser: 'main_db', port: 15432 });
		expect(() => core.workloads.activation('nod_other', entry!.id)).toThrow();
	});

	test('restarts the database and the pooler independently', async () => {
		const before = (await core.nodes.desiredState(edgeToken)).workloads.find(
			(workload) => workload.projectSlug === 'main-db',
		)!;
		core.databases.restart(owner, 'main-db', { target: 'database' });
		const after = (await core.nodes.desiredState(edgeToken)).workloads.find(
			(workload) => workload.projectSlug === 'main-db',
		)!;
		expect(after.activationVersion).not.toBe(before.activationVersion);

		const view = core.databases.restart(owner, 'main-db', { target: 'pooler' });
		expect(view.pooler.enabled).toBe(true);
		const state = await core.nodes.desiredState(edgeToken);
		expect(state.databasePoolerRestarts).toContain(view.id);
		core.databases.applyPoolerRestarted(edgeId, [view.id]);
		expect((await core.nodes.desiredState(edgeToken)).databasePoolerRestarts).not.toContain(view.id);

		const noPool = core.databases.create(owner, { name: 'no-pool', memoryMb: 128, pooler: false });
		expect(() => core.databases.restart(owner, 'no-pool', { target: 'pooler' })).toThrow(
			/does not have a pooler/,
		);
		core.databases.delete(owner, 'no-pool');
		core.databases.purgeNow(owner, 'no-pool');
		core.databases.applyPurged(edgeId, [noPool.id]);
	});

	test('rotates the owner secret only after the node confirms ALTER ROLE', async () => {
		const before = core.databases.credentials(owner, 'main-db').password;
		const rotation = core.databases.rotateCredentials(owner, 'main-db', { role: 'owner' });
		expect(rotation).toMatchObject({ role: 'owner', status: 'pending' });
		expect(() => core.databases.rotateCredentials(owner, 'main-db', { role: 'owner' })).toThrow(/already running/);
		const state = await core.nodes.desiredState(edgeToken);
		expect(state.databaseRotations.some((task) => task.id === rotation.id)).toBe(true);
		const activation = core.databases.rotationActivation(edgeId, rotation.id);
		expect(activation.password).not.toBe(before);
		expect(core.databases.credentials(owner, 'main-db').password).toBe(before);

		core.databases.applyRotationResults(edgeId, [
			{
				taskId: rotation.id,
				databaseId: rotation.databaseId,
				role: 'owner',
				status: 'ok',
			},
		]);
		expect(core.databases.credentials(owner, 'main-db').password).toBe(activation.password);
		expect(core.databases.rotations(owner, 'main-db')[0]).toMatchObject({ status: 'ok' });
	});

	test('carries allowlisted extensions into the activation only', async () => {
		const db = core.databases.create(owner, {
			name: 'ext-db',
			memoryMb: 128,
			extensions: ['pg_trgm', 'pg_stat_statements'],
		});
		expect(db.extensions).toEqual(['pg_trgm', 'pg_stat_statements']);
		const state = await core.nodes.desiredState(edgeToken);
		const workload = state.workloads.find((item) => item.projectSlug === 'ext-db')!;
		expect(JSON.stringify(workload)).not.toContain('pg_trgm');
		const activation = core.workloads.activation(edgeId, workload.id);
		expect(activation.databaseSetup?.extensions).toEqual(['pg_trgm', 'pg_stat_statements']);
		const updated = core.databases.update(owner, 'ext-db', { extensions: ['pgcrypto'] });
		expect(updated.extensions).toEqual(['pgcrypto']);
		core.databases.delete(owner, 'ext-db');
		core.databases.purgeNow(owner, 'ext-db');
		core.databases.applyPurged(edgeId, [db.id]);
	});

	test('queues a backup and records the node result', async () => {
		const backup = core.databases.createBackup(owner, 'main-db');
		expect(backup).toMatchObject({ status: 'pending', kind: 'manual', databaseName: 'main-db' });
		const state = await core.nodes.desiredState(edgeToken);
		const task = state.databaseBackupTasks.find((item) => item.action === 'backup')!;
		expect(task).toMatchObject({ databaseId: backup.databaseId, engine: 'postgres' });
		expect(task.url).toContain('/api/objects/');
		expect(JSON.stringify(state)).not.toContain('password');

		const bytes = new TextEncoder().encode('custom-format dump');
		await store.put(task.objectKey, bytes);
		core.databases.applyBackupResults(edgeId, [
			{
				taskId: backup.id,
				action: 'backup',
				databaseId: task.databaseId,
				backupId: null,
				status: 'ok',
				sizeBytes: bytes.byteLength,
				sha256: 'a'.repeat(64),
			},
		]);
		const list = core.databases.listBackups(owner, 'main-db');
		expect(list[0]).toMatchObject({ id: backup.id, status: 'ok', sizeBytes: bytes.byteLength });
		expect(core.databases.get(owner, 'main-db').backup.lastBackupStatus).toBe('ok');
	});

	test('restores a backup into a new database and tracks the verification', async () => {
		const source = core.databases.listBackups(owner, 'main-db')[0]!;
		const restored = core.databases.restoreBackup(owner, 'main-db', source.id, { name: 'main-restored' });
		expect(restored).toMatchObject({ name: 'main-restored', status: 'pending' });
		expect(restored.backup.pendingRestoreId).toBe(source.id);
		const state = await core.nodes.desiredState(edgeToken);
		const task = state.databaseBackupTasks.find((item) => item.action === 'restore')!;
		expect(task).toMatchObject({ databaseId: restored.id, backupId: source.id });
		core.databases.applyBackupResults(edgeId, [
			{
				taskId: task.id,
				action: 'restore',
				databaseId: restored.id,
				backupId: source.id,
				status: 'ok',
			},
		]);
		const again = core.databases.get(owner, 'main-restored');
		expect(again.backup.pendingRestoreId).toBeNull();
		expect(again.backup.lastVerifiedAt).not.toBeNull();
		expect(core.databases.getBackup(owner, 'main-db', source.id).verifiedAt).not.toBeNull();
		// Leave the fixture list as the later lifecycle test expects.
		core.databases.delete(owner, 'main-restored');
		core.databases.purgeNow(owner, 'main-restored');
		core.databases.applyPurged(edgeId, [restored.id]);
	});

	test('backup policy validates the cron and retention', () => {
		expect(() => core.databases.setBackupPolicy(owner, 'main-db', { schedule: 'not a cron' })).toThrow();
		const policy = core.databases.setBackupPolicy(owner, 'main-db', {
			schedule: '*/15 * * * *',
			retentionDays: 30,
		});
		expect(policy).toMatchObject({ schedule: '*/15 * * * *', retentionDays: 30, enabled: true });
		expect(policy.nextBackupAt).not.toBeNull();
	});

	test('credentials need database:credentials and are audited', () => {
		expect(() => core.databases.credentials(viewer, 'main-db')).toThrow();
		expect(() => core.databases.credentials(deployerAgent, 'main-db')).toThrow();
		const creds = core.databases.credentials(owner, 'main-db');
		expect(creds.url).toBe(`postgres://main_db:${encodeURIComponent(creds.password)}@127.0.0.1:15432/main_db`);
		const audit = core.audit.list({ orgId: 'org_1', action: 'database.credentials' });
		expect(audit.length).toBeGreaterThan(0);
		expect(JSON.stringify(audit)).not.toContain(creds.password);
	});

	test('attaching injects connection values at activation and re-versions the app', async () => {
		await core.projects.create(owner, {
			name: 'backend',
			slug: 'backend',
			runtime: 'process',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const project = core.projects.requireRow(owner, 'backend');
		await core.uploads.deployInline(owner, project, [file('index.js', 'x'), file('package.json', '{}')], {
			promote: true,
		});
		const before = (await core.nodes.desiredState(edgeToken)).workloads.find((w) => w.projectSlug === 'backend')!;
		expect(core.workloads.activation(edgeId, before.id).env.DATABASE_URL).toBeUndefined();

		const result = core.databases.attach(owner, core.projects.requireRow(owner, 'backend'), { database: 'main-db' });
		expect(result.warning).toBeNull();
		expect(result.attachment.envNames).toContain('DATABASE_URL');

		const after = (await core.nodes.desiredState(edgeToken)).workloads.find((w) => w.projectSlug === 'backend')!;
		expect(after.activationVersion).not.toBe(before.activationVersion);
		expect(JSON.stringify(after)).not.toContain('DATABASE_URL');
		const activation = core.workloads.activation(edgeId, after.id);
		expect(activation.activationVersion).toBe(after.activationVersion);
		expect(activation.env.DATABASE_HOST).toBe('127.0.0.1');
		expect(activation.env.DATABASE_PORT).toBe('15432');
		expect(activation.env.DATABASE_URL).toBe(core.databases.credentials(owner, 'main-db').url);
		expect(activation.env.DATABASE_POOL_HOST).toBe('127.0.0.1');
		expect(activation.env.DATABASE_POOL_PORT).toBe('16432');
		expect(activation.env.DATABASE_POOL_URL).toContain(':16432/');

		expect(() =>
			core.databases.attach(owner, core.projects.requireRow(owner, 'backend'), { database: 'second' }),
		).toThrow(/env prefix/);
		core.databases.attach(owner, core.projects.requireRow(owner, 'backend'), { database: 'second', envPrefix: 'CACHE_DB' });
		expect(core.workloads.activation(edgeId, after.id).env.CACHE_DB_PORT).toBe('15433');
		expect(core.databases.get(owner, 'main-db').attachments.map((item) => item.projectSlug)).toEqual(['backend']);
	});

	test('container apps reach the database by its network alias', async () => {
		await core.projects.create(owner, {
			name: 'web',
			slug: 'web',
			runtime: 'container',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const project = core.projects.requireRow(owner, 'web');
		core.workloads.setSpec(owner, project, {
			runtime: 'container',
			image: 'ghcr.io/example/web:1',
			port: 8080,
			memoryMb: 128,
			cpus: 1,
			healthPath: '/',
			socketActivation: false,
			env: {},
			secrets: [],
		});
		core.databases.attach(owner, core.projects.requireRow(owner, 'web'), { database: 'main-db' });
		await core.uploads.deployInline(owner, core.projects.requireRow(owner, 'web'), [file('index.html', 'x')], {
			promote: true,
		});
		const entry = (await core.nodes.desiredState(edgeToken)).workloads.find((w) => w.projectSlug === 'web')!;
		const db = core.databases.get(owner, 'main-db');
		const env = core.workloads.activation(edgeId, entry.id).env;
		expect(env.DATABASE_HOST).toBe(databaseAlias(db.id));
		expect(env.DATABASE_PORT).toBe('5432');
	});

	test('explicit placement on another node is refused', async () => {
		await core.projects.create(owner, {
			name: 'elsewhere',
			slug: 'elsewhere',
			runtime: 'process',
			placement: 'nod_somewhere',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		expect(() =>
			core.databases.attach(owner, core.projects.requireRow(owner, 'elsewhere'), { database: 'main-db' }),
		).toThrow(/placement/);
	});

	test('heartbeats drive status', () => {
		const db = core.databases.get(owner, 'main-db');
		core.nodes.heartbeat(edgeToken, {
			nodeId: edgeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			workloads: [{ id: db.id, status: 'running', restarts: 0 }],
		});
		expect(core.databases.get(owner, 'main-db').status).toBe('running');
	});

	test('telemetry from the owning node lands in DuckDB and SQLite', async () => {
		const db = core.databases.get(owner, 'main-db');
		const sample = (minute: number, extra: Record<string, number> = {}) => ({
			databaseId: db.id,
			bucket: new Date(clock - (3 - minute) * 60_000).toISOString(),
			up: true,
			sizeBytes: 8_000_000 + minute,
			connectionsActive: 2,
			connectionsIdle: 3,
			connectionsTotal: 5,
			maxConnections: 100,
			memoryBytes: 50_000_000,
			xactCommit: 10,
			xactRollback: 0,
			tupReturned: 100,
			tupFetched: 50,
			tupInserted: 5,
			tupUpdated: 1,
			tupDeleted: 0,
			blksHit: 990,
			blksRead: 10,
			deadlocks: 0,
			tempBytes: 0,
			...extra,
		});
		const result = await core.databases.ingestTelemetry(
			edgeId,
			[sample(1), sample(2), { ...sample(3), databaseId: 'db_not_mine' }],
			[
				{
					databaseId: db.id,
					at: new Date(clock).toISOString(),
					tables: [
						{
							schema: 'public',
							name: 'users',
							rows: 42,
							totalBytes: 16_384,
							seqScans: 1,
							idxScans: 9,
							lastAutovacuum: null,
							lastAutoanalyze: null,
						},
					],
				},
			],
		);
		expect(result.stored).toBe(2);
		const view = core.databases.get(owner, 'main-db');
		expect(view.sizeBytes).toBe(8_000_002);
		expect(view.tables[0]).toMatchObject({ name: 'users', rows: 42 });

		const points = await core.databases.metrics(owner, 'main-db', {
			from: clock - 3_600_000,
			to: clock,
			interval: '1m',
		});
		expect(points).toHaveLength(2);
		expect(points[0]).toMatchObject({ xactCommit: 10, connectionsTotal: 5, up: 1 });

		const latest = await telemetry.latestDatabaseMetrics(clock - 3_600_000);
		expect(latest).toEqual([
			expect.objectContaining({ databaseId: db.id, connectionsTotal: 5, maxConnections: 100, up: true }),
		]);
		expect(await telemetry.getPrometheusMetrics()).toContain(`skiff_database_up{database_id="${db.id}"} 1`);

		await telemetry.rollupHourly(clock - 2 * 3_600_000, clock + 3_600_000);
		const hourly = await core.databases.metrics(owner, 'main-db', {
			from: clock - 3_600_000,
			to: clock,
			interval: '1h',
		});
		expect(hourly.reduce((sum, point) => sum + point.xactCommit, 0)).toBe(20);
	});

	test('delete is refused while attached, then soft, restorable and purged by the node', async () => {
		expect(() => core.databases.delete(owner, 'second')).toThrow(/attached/);
		core.databases.detach(owner, core.projects.requireRow(owner, 'backend'), 'second');
		const deleted = core.databases.delete(owner, 'second');
		expect(deleted.deletedAt).not.toBeNull();
		let state = await core.nodes.desiredState(edgeToken);
		expect(state.workloads.some((w) => w.projectSlug === 'second')).toBe(false);
		expect(state.databasePurges).toEqual([]);

		core.databases.restore(owner, 'second');
		state = await core.nodes.desiredState(edgeToken);
		expect(state.workloads.some((w) => w.projectSlug === 'second')).toBe(true);

		core.databases.delete(owner, 'second');
		clock += 8 * 86_400_000;
		await core.maintenance.run();
		state = await core.nodes.desiredState(edgeToken);
		const id = core.databases.get(owner, 'second', { includeDeleted: true }).id;
		expect(state.databasePurges).toEqual([id]);
		expect(() => core.databases.restore(owner, 'second')).toThrow(/purged/);

		core.nodes.heartbeat(edgeToken, {
			nodeId: edgeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			purgedDatabases: [id],
		});
		expect(() => core.databases.get(owner, 'second', { includeDeleted: true })).toThrow(/not found/);
		expect(core.databases.list(owner).map((db) => db.name)).toEqual(['main-db']);
	});

	test('project purge drops its attachments', async () => {
		await core.projects.softDelete(owner, 'web');
		await core.projects.purgeNow(owner, 'web');
		expect(core.databases.get(owner, 'main-db').attachments.map((item) => item.projectSlug)).toEqual(['backend']);
	});
});

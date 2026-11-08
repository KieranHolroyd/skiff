import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { databaseAlias, DEFAULT_FEATURES, orgNetworkName } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { disposeTelemetryStore, hasClickHouse, testTelemetryStore } from './test-clickhouse.ts';
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
		features: { ...DEFAULT_FEATURES, ORG_NETWORKS: true, DB_TLS: false, SERVICE_ENDPOINTS: false },
	},
});
const telemetry = testTelemetryStore({ now: () => clock });
core.ctx.telemetry = telemetry;

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_2', role: 'owner' });
const deployerAgent = buildPrincipal({
	kind: 'mcp',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	granted: ['database:read', 'database:create'],
});
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });

afterAll(async () => {
	await disposeTelemetryStore(telemetry);
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

	test('rejects a PostgreSQL major change in update and plans it explicitly', async () => {
		const second = core.databases.get(owner, 'second');
		core.databases.applyHeartbeat(edgeId, [{ id: second.id, status: 'running', restarts: 0 }]);
		expect(() => core.databases.update(owner, 'second', { version: '16' })).toThrow(
			/major-version upgrade.*skif db upgrade second --to 16 --plan/
		);
		expect(core.databases.get(owner, 'second').version).toBe('17');
		// The same major has nothing to plan, and the message names a command that exists.
		expect(() => core.databases.upgradeDatabase(owner, 'second', { targetVersion: '17' })).toThrow(
			/already runs PostgreSQL 17.*skif db update second/
		);

		const plan = core.databases.upgradeDatabase(owner, 'second', { targetVersion: '16' });
		expect(plan).toMatchObject({
			name: 'second',
			fromVersion: '17',
			toVersion: '16',
			majorChange: true,
			status: 'planned',
			mode: 'dump-restore',
			backupId: null
		});
		expect(plan.steps.map((step) => step.id)).toEqual(['freeze', 'backup', 'preflight', 'upgrade', 'verify']);

		const applied = core.databases.upgradeDatabase(owner, 'second', { targetVersion: '16', apply: true });
		expect(applied.status).toBe('manual');
		expect(applied.backupId).toMatch(/^bkp_/);
		expect(core.databases.listBackups(owner, 'second').some((backup) => backup.pinned)).toBe(true);
		// The row still says 17: applying the plan only queues the backup and runbook.
		expect(core.databases.get(owner, 'second').version).toBe('17');
		const pending = (await core.nodes.desiredState(edgeToken)).databaseBackupTasks.find(
			(task) => task.databaseId === second.id
		);
		if (pending)
			core.databases.applyBackupResults(edgeId, [
				{ taskId: pending.id, action: 'backup', databaseId: second.id, backupId: null, status: 'ok' }
			]);
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

	test('two orgs get separate networks; same-org workloads share one', async () => {
		const other = core.databases.create(otherOrg, { name: 'main-db', memoryMb: 128 });
		const sameOrg = core.databases.create(owner, { name: 'shares-network', memoryMb: 128 });
		const state = await core.nodes.desiredState(edgeToken);
		const mine = state.workloads.find((item) => item.id === core.databases.get(owner, 'main-db').id)!;
		const theirs = state.workloads.find((item) => item.id === other.id)!;
		const sibling = state.workloads.find((item) => item.id === sameOrg.id)!;
		expect(mine.networkName).toBe(orgNetworkName('org_1'));
		expect(sibling.networkName).toBe(mine.networkName);
		expect(theirs.networkName).toBe(orgNetworkName('org_2'));
		expect(theirs.networkName).not.toBe(mine.networkName);

		core.databases.delete(otherOrg, 'main-db');
		core.databases.purgeNow(otherOrg, 'main-db');
		core.databases.applyPurged(edgeId, [other.id]);
		core.databases.delete(owner, 'shares-network');
		core.databases.purgeNow(owner, 'shares-network');
		core.databases.applyPurged(edgeId, [sameOrg.id]);
	});

	test('named credentials are provisioned, rotated and revealed only interactively', async () => {
		const created = core.databases.createCredential(owner, 'main-db', {
			role: 'app',
			purpose: 'web app',
		});
		expect(created).toMatchObject({ role: 'app', status: 'pending' });
		expect(created.username).toStartWith('skiff_app_');
		expect(() => core.databases.revealCredential(owner, 'main-db', created.id)).toThrow(/not active/);

		const tasks = (await core.nodes.desiredState(edgeToken)).databaseCredentialTasks;
		const task = tasks.find((item) => item.id === created.id)!;
		expect(task).toMatchObject({ action: 'grant', role: 'app', username: created.username });
		const activation = core.databases.credentialActivation(edgeId, created.id);
		expect(activation.password).toBeTruthy();
		expect(JSON.stringify(await core.nodes.desiredState(edgeToken))).not.toContain(activation.password!);

		core.databases.applyCredentialResults(edgeId, [
			{ taskId: created.id, databaseId: created.databaseId, status: 'ok' },
		]);
		expect(core.databases.listCredentials(owner, 'main-db').find((item) => item.id === created.id)).toMatchObject({
			status: 'ready',
		});
		const revealed = core.databases.revealCredential(owner, 'main-db', created.id);
		expect(revealed.password).toBe(activation.password!);
		expect(() => core.databases.revealCredential(deployerAgent, 'main-db', created.id)).toThrow();

		expect(core.audit.list({ orgId: 'org_1', action: 'database.credential.create' }).length).toBeGreaterThan(0);
		core.databases.rotateNamedCredential(owner, 'main-db', created.id);
		expect(core.audit.list({ orgId: 'org_1', action: 'database.credential.rotate' }).length).toBeGreaterThan(0);
		const rotateTask = (await core.nodes.desiredState(edgeToken)).databaseCredentialTasks.find(
			(item) => item.id === created.id,
		)!;
		expect(rotateTask.action).toBe('grant');
		const rotated = core.databases.credentialActivation(edgeId, created.id);
		expect(rotated.password).not.toBe(activation.password!);
		core.databases.applyCredentialResults(edgeId, [
			{ taskId: created.id, databaseId: created.databaseId, status: 'ok' },
		]);
		expect(core.databases.revealCredential(owner, 'main-db', created.id).password).toBe(rotated.password!);

		core.databases.revokeCredential(owner, 'main-db', created.id);
		expect(core.audit.list({ orgId: 'org_1', action: 'database.credential.revoke' }).length).toBeGreaterThan(0);
		const revoke = (await core.nodes.desiredState(edgeToken)).databaseCredentialTasks.find(
			(item) => item.id === created.id,
		)!;
		expect(revoke.action).toBe('revoke');
		core.databases.applyCredentialResults(edgeId, [
			{ taskId: created.id, databaseId: created.databaseId, status: 'ok' },
		]);
		expect(core.databases.listCredentials(owner, 'main-db').find((item) => item.id === created.id)?.status).toBe(
			'revoked',
		);

		const audit = core.audit.list({ orgId: 'org_1', action: 'database.credentials.reveal' });
		expect(audit.length).toBeGreaterThan(0);
		expect(JSON.stringify(audit)).not.toContain(revealed.password);
	});

	test('attachments reference the built-in owner credential row', () => {
		expect(core.databases.listCredentials(owner, 'main-db').some((item) => item.role === 'owner')).toBe(true);
		expect(core.databases.listCredentials(owner, 'main-db').some((item) => item.role === 'monitor')).toBe(true);
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
		const ownerCredential = core.databases.listCredentials(owner, 'main-db').find((item) => item.role === 'owner')!;
		expect(core.databases.revealCredential(owner, 'main-db', ownerCredential.id).password).toBe(activation.password);
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

	test('image variants (D126) pick the image, add their extension and survive a restore', async () => {
		const db = core.databases.create(owner, { name: 'geo-db', memoryMb: 128, version: '18', variant: 'postgis' });
		expect(db).toMatchObject({ variant: 'postgis', version: '18', extensions: ['postgis'] });
		const state = await core.nodes.desiredState(edgeToken);
		const workload = state.workloads.find((item) => item.projectSlug === 'geo-db')!;
		expect(workload.image).toBe('ghcr.io/kieranholroyd/skiff-postgres:18-postgis-1');
		expect(workload.database).toMatchObject({ engine: 'postgres', version: '18', variant: 'postgis' });
		// Standard databases send no variant, so older helpers keep accepting them.
		const main = state.workloads.find((item) => item.projectSlug === 'main-db')!;
		expect(main.database && 'variant' in main.database).toBe(false);
		expect(() => core.databases.update(owner, 'geo-db', { extensions: ['postgis', 'pg_cron'] })).toThrow(
			/pg_cron variant/,
		);
		expect(() => core.databases.update(owner, 'main-db', { extensions: ['postgis'] })).toThrow(/PostGIS variant/);

		const backup = core.databases.createBackup(owner, 'geo-db');
		const task = (await core.nodes.desiredState(edgeToken)).databaseBackupTasks.find(
			(item) => item.databaseId === db.id,
		)!;
		await store.put(task.objectKey, new TextEncoder().encode('dump'));
		core.databases.applyBackupResults(edgeId, [
			{ taskId: backup.id, action: 'backup', databaseId: db.id, backupId: null, status: 'ok', sizeBytes: 4, sha256: 'b'.repeat(64) },
		]);
		const restored = core.databases.restoreBackup(owner, 'geo-db', backup.id, { name: 'geo-restored' });
		expect(restored).toMatchObject({ variant: 'postgis', version: '18' });

		for (const name of ['geo-restored', 'geo-db']) {
			const row = core.databases.get(owner, name);
			core.databases.delete(owner, name);
			core.databases.purgeNow(owner, name);
			core.databases.applyPurged(edgeId, [row.id]);
		}
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
		const mcpWithScope = buildPrincipal({ kind: 'mcp', userId: 'user_1', orgId: 'org_1', role: 'owner' });
		expect(() => core.databases.credentials(mcpWithScope, 'main-db')).toThrow(/never returned over MCP/);
		const cliKey = buildPrincipal({ kind: 'apiKey', userId: 'user_1', orgId: 'org_1', role: 'owner', keyId: 'key_cli' });
		expect(core.databases.credentials(cliKey, 'main-db').username).toBe('main_db');
		const creds = core.databases.credentials(owner, 'main-db');
		expect(creds.url).toBe(`postgres://main_db:${encodeURIComponent(creds.password)}@127.0.0.1:15432/main_db`);
		const audit = core.audit.list({ orgId: 'org_1', action: 'database.credentials' });
		expect(audit.length).toBeGreaterThan(0);
		expect(JSON.stringify(audit)).not.toContain(creds.password);
	});

	test('resource scopes: a project binding covers attached databases and a database binding its own', async () => {
		// A separate org keeps this test's `iam_bindings`/`iamVersion` away from org_1, whose
		// principals still rely on the I2 compatibility fallback in the other tests.
		const scopedOwner = buildPrincipal({
			kind: 'user',
			userId: 'user_scoped_owner',
			orgId: 'org_scope',
			role: 'owner',
		});
		for (const [name, slug] of [
			['Scoped app', 'scoped-app'],
			['Other app', 'other-app'],
		] as const) {
			await core.projects.create(scopedOwner, {
				name,
				slug,
				runtime: 'process',
				placement: 'auto',
				productionAccess: 'public',
				previewAccess: 'platform',
			});
		}
		const scopedProject = core.projects.requireRow(scopedOwner, 'scoped-app');
		const otherProject = core.projects.requireRow(scopedOwner, 'other-app');
		const scopedDb = core.databases.create(scopedOwner, {
			name: 'scoped-db',
			project: 'scoped-app',
			memoryMb: 128,
		});
		const otherDb = core.databases.create(scopedOwner, {
			name: 'other-db',
			project: 'other-app',
			memoryMb: 128,
		});

		// Bind the owner first: the write bumps `iamVersion`, after which org_scope principals are
		// resolved from bindings rather than the legacy fallback (there is no `member` table here).
		core.ctx.iam.bind(scopedOwner, {
			principalType: 'user',
			principalId: 'user_scoped_owner',
			roleId: 'owner',
			scope: { type: 'org' },
		});

		// A project-scope grant covers a database through any of its attachments, and nothing else.
		core.ctx.iam.bind(scopedOwner, {
			principalType: 'user',
			principalId: 'user_project_guest',
			roleId: 'deployer',
			scope: { type: 'project', id: scopedProject.id },
		});
		const projectGuest = buildPrincipal({
			kind: 'user',
			userId: 'user_project_guest',
			orgId: 'org_scope',
			role: 'viewer',
		});
		expect(core.databases.list(projectGuest).map((db) => db.name)).toEqual(['scoped-db']);
		expect(core.databases.get(projectGuest, 'scoped-db').id).toBe(scopedDb.id);
		expect(() => core.databases.get(projectGuest, 'other-db')).toThrow(/database:read/);
		expect(core.databases.credentials(projectGuest, 'scoped-db').username).toBe('scoped_db');
		expect(() => core.databases.credentials(projectGuest, 'other-db')).toThrow(/database:credentials/);

		// A database-scope grant covers that database directly, even with no project to report.
		core.ctx.iam.bind(scopedOwner, {
			principalType: 'user',
			principalId: 'user_database_guest',
			roleId: 'viewer',
			scope: { type: 'database', id: otherDb.id },
		});
		const databaseGuest = buildPrincipal({
			kind: 'user',
			userId: 'user_database_guest',
			orgId: 'org_scope',
			role: 'viewer',
		});
		expect(core.databases.list(databaseGuest).map((db) => db.name)).toEqual(['other-db']);
		expect(core.databases.get(databaseGuest, 'other-db').id).toBe(otherDb.id);
		expect(() => core.databases.get(databaseGuest, 'scoped-db')).toThrow(/database:read/);
		// viewer holds database:read but not database:update or database:credentials.
		expect(() => core.databases.update(databaseGuest, 'other-db', { memoryMb: 256 })).toThrow(
			/database:update/,
		);
		expect(() => core.databases.credentials(databaseGuest, 'other-db')).toThrow(/database:credentials/);

		// Return the node's memory so the later deployment tests keep their capacity.
		for (const [project, name] of [
			['scoped-app', 'scoped-db'],
			['other-app', 'other-db'],
		] as const) {
			core.databases.detach(scopedOwner, core.projects.requireRow(scopedOwner, project), name);
			core.databases.delete(scopedOwner, name);
			core.databases.purgeNow(scopedOwner, name);
		}
		core.databases.applyPurged(edgeId, [scopedDb.id, otherDb.id]);
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

	test('DB_TLS publishes direct and pooled URLs, injects the CA, and keeps the key off the wire', async () => {
		const previous = core.ctx.config.features;
		core.ctx.config.features = { ...(previous ?? DEFAULT_FEATURES), DB_TLS: true };
		const db = core.databases.get(owner, 'main-db');
		try {
			const pending = core.databases.credentials(owner, 'main-db');
			expect(pending.sslmode).toBe('require');
			expect(pending.tlsEnabled).toBe(true);
			expect(pending.url).toContain('sslmode=require');
			expect(pending.directUrl).toContain(':15432/');
			expect(pending.poolerUrl).toContain(':16432/');
			expect(pending.poolerUrl).toContain('sslmode=require');
			expect(pending.caPem).toBeNull();
			expect(Object.keys(pending.connectionSnippets)).toEqual(
				expect.arrayContaining(['psql', 'prisma', 'drizzle', 'kysely', 'django', 'rails', 'pgx', 'nodePostgres']),
			);

			core.databases.applyTlsReport(edgeId, [
				{ id: db.id, enabled: true, caPem: '-----BEGIN CERTIFICATE-----\nCA\n' },
			]);
			const creds = core.databases.credentials(owner, 'main-db');
			expect(creds.caPem).toContain('BEGIN CERTIFICATE');
			expect(core.databases.get(owner, 'main-db').tls).toEqual({
				enabled: true,
				mode: 'require',
				caPem: '-----BEGIN CERTIFICATE-----\nCA\n',
				error: null,
			});

			const workload = (await core.nodes.desiredState(edgeToken)).workloads.find(
				(item) => item.projectSlug === 'backend',
			)!;
			const activation = core.workloads.activation(edgeId, workload.id);
			expect(activation.env.DATABASE_URL).toContain('sslmode=require');
			expect(activation.env.DATABASE_POOL_URL).toContain('sslmode=require');
			expect(activation.env.DATABASE_SSL_MODE).toBe('require');
			expect(activation.env.DATABASE_CA_CERT).toContain('BEGIN CERTIFICATE');
			expect(JSON.stringify(workload)).not.toContain('BEGIN CERTIFICATE');
		} finally {
			core.ctx.config.features = previous;
			core.databases.applyTlsReport(edgeId, [{ id: db.id, enabled: false }]);
		}
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

	test('a confirmed owner rotation re-activates attached process and container apps (D86)', async () => {
		const consumers = async () =>
			(await core.nodes.desiredState(edgeToken)).workloads.filter(
				(w) => w.projectSlug === 'backend' || w.projectSlug === 'web',
			);
		const before = await consumers();
		expect(before.map((w) => w.projectSlug).sort()).toEqual(['backend', 'web']);
		const versions = (list: typeof before) => Object.fromEntries(list.map((w) => [w.projectSlug, w.activationVersion]));

		// A monitor rotation changes nothing an app connects with.
		const monitor = core.databases.rotateCredentials(owner, 'main-db', { role: 'monitor' });
		core.databases.applyRotationResults(edgeId, [
			{ taskId: monitor.id, databaseId: monitor.databaseId, role: 'monitor', status: 'ok' },
		]);
		expect(versions(await consumers())).toEqual(versions(before));

		const rotation = core.databases.rotateCredentials(owner, 'main-db', { role: 'owner' });
		const next = core.databases.rotationActivation(edgeId, rotation.id).password;
		// Until the node confirms ALTER ROLE, apps keep their version and the old password.
		expect(versions(await consumers())).toEqual(versions(before));
		const backend = before.find((w) => w.projectSlug === 'backend')!;
		expect(core.workloads.activation(edgeId, backend.id).env.DATABASE_PASSWORD).not.toBe(next);

		core.databases.applyRotationResults(edgeId, [
			{ taskId: rotation.id, databaseId: rotation.databaseId, role: 'owner', status: 'ok' },
		]);
		const after = await consumers();
		for (const workload of after) {
			expect(workload.activationVersion).not.toBe(versions(before)[workload.projectSlug]);
			const activation = core.workloads.activation(edgeId, workload.id);
			expect(activation.activationVersion).toBe(workload.activationVersion);
			expect(activation.env.DATABASE_PASSWORD).toBe(next);
			expect(activation.env.DATABASE_URL).toContain(encodeURIComponent(next));
			expect(JSON.stringify(workload)).not.toContain(next);
		}
		// A failed rotation leaves the live secret, and so the apps, alone.
		const failed = core.databases.rotateCredentials(owner, 'main-db', { role: 'owner' });
		core.databases.applyRotationResults(edgeId, [
			{ taskId: failed.id, databaseId: failed.databaseId, role: 'owner', status: 'failed', error: 'boom' },
		]);
		expect(versions(await consumers())).toEqual(versions(after));
	});

	test('apps can connect as a named credential, which rotates and revokes safely', async () => {
		const cliKey = buildPrincipal({ kind: 'apiKey', userId: 'user_1', orgId: 'org_1', role: 'owner', keyId: 'key_cli' });
		const mcpWithScope = buildPrincipal({ kind: 'mcp', userId: 'user_1', orgId: 'org_1', role: 'owner' });
		const app = core.databases.createCredential(owner, 'main-db', { role: 'app', purpose: 'worker' });
		await core.projects.create(owner, {
			name: 'worker',
			slug: 'worker',
			runtime: 'process',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const project = () => core.projects.requireRow(owner, 'worker');
		expect(() => core.databases.attach(owner, project(), { database: 'main-db', credential: app.id })).toThrow(
			/not ready/,
		);
		const grant = core.databases.credentialActivation(edgeId, app.id).password!;
		core.databases.applyCredentialResults(edgeId, [{ taskId: app.id, databaseId: app.databaseId, status: 'ok' }]);

		const attached = core.databases.attach(owner, project(), { database: 'main-db', credential: 'app' });
		expect(attached.attachment).toMatchObject({ credentialId: app.id, credentialRole: 'app' });
		expect(attached.attachment.envNames).not.toContain('DATABASE_POOL_URL');
		await core.uploads.deployInline(owner, project(), [file('index.js', 'x'), file('package.json', '{}')], {
			promote: true,
		});
		const workload = async () =>
			(await core.nodes.desiredState(edgeToken)).workloads.find((w) => w.projectSlug === 'worker')!;
		const first = await workload();
		const env = core.workloads.activation(edgeId, first.id).env;
		expect(env.DATABASE_USER).toBe(app.username);
		expect(env.DATABASE_PASSWORD).toBe(grant);
		expect(env.DATABASE_NAME).toBe('main_db');
		expect(env.DATABASE_URL).toContain(`${app.username}:`);
		expect(env.DATABASE_URL).toEndWith('/main_db');
		expect(env.DATABASE_POOL_URL).toBeUndefined();

		// Rotation is staged like the owner's: the app keeps the old password until the node confirms.
		core.databases.rotateNamedCredential(owner, 'main-db', app.id);
		const rotated = core.databases.credentialActivation(edgeId, app.id).password!;
		expect((await workload()).activationVersion).toBe(first.activationVersion);
		expect(core.workloads.activation(edgeId, first.id).env.DATABASE_PASSWORD).toBe(grant);
		core.databases.applyCredentialResults(edgeId, [{ taskId: app.id, databaseId: app.databaseId, status: 'ok' }]);
		const second = await workload();
		expect(second.activationVersion).not.toBe(first.activationVersion);
		expect(core.workloads.activation(edgeId, second.id).env.DATABASE_PASSWORD).toBe(rotated);

		// Reveal is gated like the owner URL: CLI keys yes, MCP never.
		expect(core.databases.revealCredential(cliKey, 'main-db', app.id).password).toBe(rotated);
		expect(() => core.databases.revealCredential(mcpWithScope, 'main-db', app.id)).toThrow(/never returned over MCP/);

		expect(() => core.databases.revokeCredential(owner, 'main-db', app.id)).toThrow(/worker connects as this/);
		core.databases.detach(owner, project(), 'main-db');
		expect(core.databases.revokeCredential(owner, 'main-db', app.id).status).toBe('revoking');
		core.databases.applyCredentialResults(edgeId, [{ taskId: app.id, databaseId: app.databaseId, status: 'ok' }]);
		expect(() => core.databases.attach(owner, project(), { database: 'main-db', credential: app.id })).toThrow(
			/not found/i,
		);
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

	test.skipIf(!hasClickHouse)('telemetry from the owning node lands in ClickHouse and SQLite', async () => {
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
			poolerUp: 0,
			poolActive: 0,
			poolIdle: 0,
			poolWaiting: 0,
			poolSaturation: 0,
			poolAvgWaitMs: 0,
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

	test('bulk service actions restart databases and queue backups', async () => {
		const bulk = core.databases.create(owner, { name: 'bulk-db', memoryMb: 128, pooler: false });
		const restarted = core.serviceActions.restart(owner, { scope: 'databases' });
		expect(restarted.restarted.databases).toContain('main-db');
		expect(restarted.restarted.databases).toContain('bulk-db');
		expect(restarted.skipped).toEqual([]);

		const backups = core.serviceActions.backupAllDatabases(owner);
		expect(backups.queued).toContain('bulk-db');
		core.databases.delete(owner, 'bulk-db');
		core.databases.purgeNow(owner, 'bulk-db');
		core.databases.applyPurged(edgeId, [bulk.id]);
	});

	test('project purge drops its attachments', async () => {
		await core.projects.softDelete(owner, 'web');
		await core.projects.purgeNow(owner, 'web');
		expect(core.databases.get(owner, 'main-db').attachments.map((item) => item.projectSlug)).toEqual(['backend']);
	});
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { DEFAULT_FEATURES, databaseCreateSchema, databaseStudioPrincipalActivationSchema } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-studio-principal-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-06T10:00:00Z');
const features = { ...DEFAULT_FEATURES, ORG_NETWORKS: true, DB_STUDIO: true };

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
		features,
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

let edgeToken = '';
let edgeId = '';
let workerId = '';
let workerToken = '';

function failure(fn: () => unknown): { status: number; message: string } {
	try {
		fn();
	} catch (error) {
		return error as { status: number; message: string };
	}
	throw new Error('expected the call to throw');
}

async function principalTasks(token = edgeToken) {
	return (await core.nodes.desiredState(token)).databaseStudioPrincipals;
}

function generationOf(id: string): { generation: number; ready: number } {
	const row = opened.sqlite
		.query<{ g: number; r: number }, [string]>(
			'SELECT studio_ro_generation AS g, studio_ro_ready_generation AS r FROM databases WHERE id = ?',
		)
		.get(id)!;
	return { generation: row.g, ready: row.r };
}

function running(nodeId: string, id: string): void {
	core.databases.applyHeartbeat(nodeId, [{ id, status: 'running', restarts: 0 }]);
}

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
	edgeToken = joined.token;
	edgeId = joined.nodeId;
	const worker = core.nodes.join({
		token: core.nodes.createJoinToken(owner, 'worker').token,
		name: 'worker',
		publicAddress: '203.0.113.20',
	});
	workerId = worker.nodeId;
	workerToken = worker.token;
});

describe('read-only studio principal', () => {
	test('the name is reserved for every engine', () => {
		for (const engine of ['postgres', 'mysql', 'mariadb', 'mongodb', 'valkey', 'redis'] as const)
			expect(databaseCreateSchema.safeParse({ name: 'skiff-studio-ro', engine }).success).toBe(false);
		expect(() => core.databases.create(owner, { name: 'skiff-studio-ro', memoryMb: 128 })).toThrow(/reserved/);
	});

	test('create mints it; the task waits until the database runs and never carries the password', async () => {
		const db = core.databases.create(owner, { name: 'shop-db', memoryMb: 128, placement: edgeId });
		expect(generationOf(db.id)).toEqual({ generation: 1, ready: 0 });
		expect(await principalTasks()).toEqual([]);

		running(edgeId, db.id);
		const state = await core.nodes.desiredState(edgeToken);
		expect(state.databaseStudioPrincipals).toEqual([{ databaseId: db.id, generation: 1 }]);

		const activation = core.databaseStudio.principals.activation(edgeId, db.id);
		expect(databaseStudioPrincipalActivationSchema.parse(activation)).toEqual(activation);
		expect(activation).toMatchObject({ databaseId: db.id, generation: 1, engine: 'postgres', user: 'skiff_studio_ro', database: 'shop_db' });
		expect(JSON.stringify(state)).not.toContain(activation.password);
		// Only sealed at rest.
		const raw = opened.sqlite
			.query<{ s: string }, [string]>('SELECT studio_ro_secret AS s FROM databases WHERE id = ?')
			.get(db.id)!;
		expect(raw.s).not.toContain(activation.password);

		// The studio flag gates the task list, so an older helper is never asked.
		features.DB_STUDIO = false;
		try {
			expect(await principalTasks()).toEqual([]);
		} finally {
			features.DB_STUDIO = true;
		}
	});

	test('activation is scoped to the node the database is placed on', () => {
		const db = core.databases.get(owner, 'shop-db');
		expect(failure(() => core.databaseStudio.principals.activation(workerId, db.id)).status).toBe(403);
		expect(failure(() => core.databaseStudio.principals.activation(edgeId, 'db_missing')).status).toBe(404);
	});

	test('a read-only session prepares, then connects as the principal; a write session uses the owner', async () => {
		const db = core.databases.get(owner, 'shop-db');
		const view = core.databaseStudio.open(owner, 'shop-db');
		expect(view).toMatchObject({ active: true, readOnly: true, principal: 'preparing', principalError: null });
		// Opening again while preparing does not start another generation.
		core.databaseStudio.open(owner, 'shop-db');
		expect(generationOf(db.id).generation).toBe(1);
		expect(() => core.databaseStudio.endpoint(owner, 'shop-db')).toThrow(/Preparing read-only access/);

		core.nodes.heartbeat(edgeToken, {
			nodeId: edgeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			capabilities: ['studio-principal'],
			releases: [],
			databaseStudioPrincipalResults: [{ databaseId: db.id, generation: 1, status: 'ok' }],
		});
		expect(core.databaseStudio.view(owner, 'shop-db')).toMatchObject({ principal: 'ready', principalError: null });
		expect(await principalTasks()).toEqual([]);

		const endpoint = core.databaseStudio.endpoint(owner, 'shop-db');
		const readOnly = core.databaseStudio.activation(edgeId, endpoint.sessionId, endpoint.token);
		const principal = core.databaseStudio.principals.activation(edgeId, db.id);
		expect(readOnly).toMatchObject({ readOnly: true, user: 'skiff_studio_ro', password: principal.password });

		const owned = core.databases.credentials(owner, 'shop-db');
		core.databaseStudio.open(owner, 'shop-db', { readOnly: false });
		expect(core.databaseStudio.view(owner, 'shop-db')).toMatchObject({ readOnly: false, principal: 'ready' });
		const writer = core.databaseStudio.endpoint(owner, 'shop-db');
		const writable = core.databaseStudio.activation(edgeId, writer.sessionId, writer.token);
		expect(writable).toMatchObject({ readOnly: false, user: 'shop_db', password: owned.password });

		// The secret never shows up in a view or the audit log.
		const views = JSON.stringify([core.databaseStudio.view(owner, 'shop-db'), core.databases.get(owner, 'shop-db')]);
		expect(views).not.toContain(principal.password);
		expect(JSON.stringify(core.audit.list({ orgId: 'org_1', limit: 500 }))).not.toContain(principal.password);
		core.databaseStudio.close(owner, 'shop-db');
	});

	test('a failure is shown with its error and a read-only open retries it', async () => {
		const db = core.databases.create(owner, { name: 'flaky-db', memoryMb: 128, placement: edgeId });
		running(edgeId, db.id);
		const stale = core.databaseStudio.principals.activation(edgeId, db.id);
		// A result for another node, or an older generation, is ignored.
		core.databaseStudio.principals.applyResults(workerId, [{ databaseId: db.id, generation: 1, status: 'ok' }]);
		core.databaseStudio.principals.applyResults(edgeId, [{ databaseId: db.id, generation: 9, status: 'ok' }]);
		expect(generationOf(db.id)).toEqual({ generation: 1, ready: 0 });

		core.databaseStudio.principals.applyResults(edgeId, [
			{ databaseId: db.id, generation: 1, status: 'failed', error: 'Could not create the read-only principal on postgres (exit 2): boom' },
		]);
		expect(core.databaseStudio.view(owner, 'flaky-db')).toMatchObject({
			principal: 'failed',
			principalError: 'Could not create the read-only principal on postgres (exit 2): boom',
		});
		expect((await principalTasks()).some((task) => task.databaseId === db.id)).toBe(false);

		const retried = core.databaseStudio.open(owner, 'flaky-db');
		expect(retried).toMatchObject({ principal: 'preparing', principalError: null });
		expect(await principalTasks()).toContainEqual({ databaseId: db.id, generation: 2 });
		// Same password: a re-apply never strands a session the studio already activated.
		expect(core.databaseStudio.principals.activation(edgeId, db.id).password).toBe(stale.password);
		core.databaseStudio.close(owner, 'flaky-db');
	});

	test('a database from before track G gets its principal on the first read-only open', async () => {
		const db = core.databases.create(owner, { name: 'legacy-db', memoryMb: 128, placement: edgeId });
		running(edgeId, db.id);
		opened.sqlite.run(
			'UPDATE databases SET studio_ro_secret = NULL, studio_ro_generation = 0, studio_ro_ready_generation = 0 WHERE id = ?',
			[db.id],
		);
		expect((await principalTasks()).some((task) => task.databaseId === db.id)).toBe(false);
		expect(core.databaseStudio.view(owner, 'legacy-db').principal).toBe('preparing');
		// A write session never mints it.
		core.databaseStudio.open(owner, 'legacy-db', { readOnly: false });
		expect(generationOf(db.id).generation).toBe(0);
		core.databaseStudio.open(owner, 'legacy-db');
		expect(generationOf(db.id).generation).toBe(1);
		expect(await principalTasks()).toContainEqual({ databaseId: db.id, generation: 1 });
		core.databaseStudio.close(owner, 'legacy-db');
	});

	test('a restore bumps the generation; the task waits for the restore to finish', async () => {
		const backup = core.databases.createBackup(owner, 'shop-db');
		const task = (await core.nodes.desiredState(edgeToken)).databaseBackupTasks.find((item) => item.action === 'backup')!;
		const bytes = new TextEncoder().encode('custom-format dump');
		await store.put(task.objectKey, bytes);
		core.databases.applyBackupResults(edgeId, [
			{ taskId: backup.id, action: 'backup', databaseId: task.databaseId, backupId: null, status: 'ok', sizeBytes: bytes.byteLength, sha256: 'a'.repeat(64) },
		]);

		const restored = core.databases.restoreBackup(owner, 'shop-db', backup.id, { name: 'shop-restored' });
		const token = restored.nodeId === edgeId ? edgeToken : workerToken;
		running(restored.nodeId, restored.id);
		expect(generationOf(restored.id)).toEqual({ generation: 1, ready: 0 });
		// Still restoring: no task yet.
		expect((await principalTasks(token)).some((item) => item.databaseId === restored.id)).toBe(false);
		const restore = (await core.nodes.desiredState(token)).databaseBackupTasks.find((item) => item.action === 'restore')!;
		core.databases.applyBackupResults(restored.nodeId, [
			{ taskId: restore.id, action: 'restore', databaseId: restored.id, backupId: backup.id, status: 'ok' },
		]);
		expect(generationOf(restored.id)).toEqual({ generation: 2, ready: 0 });
		expect(await principalTasks(token)).toContainEqual({ databaseId: restored.id, generation: 2 });
	});

	test('a ready principal is re-applied after an engine version change', async () => {
		const db = core.databases.create(owner, { name: 'cache-db', memoryMb: 128, engine: 'valkey', version: '8.1', placement: edgeId });
		running(edgeId, db.id);
		core.databaseStudio.principals.applyResults(edgeId, [{ databaseId: db.id, generation: 1, status: 'ok' }]);
		expect(core.databaseStudio.view(owner, 'cache-db').principal).toBe('ready');
		core.databases.update(owner, 'cache-db', { version: '9.1' });
		expect(generationOf(db.id)).toEqual({ generation: 2, ready: 1 });
		expect(core.databaseStudio.view(owner, 'cache-db').principal).toBe('preparing');
		expect(await principalTasks()).toContainEqual({ databaseId: db.id, generation: 2 });
		// A memory change alone does not.
		core.databases.update(owner, 'cache-db', { memoryMb: 192 });
		expect(generationOf(db.id).generation).toBe(2);
	});

	test('a node whose agent predates the principal fails fast instead of preparing forever', () => {
		const old = core.nodes.join({
			token: core.nodes.createJoinToken(owner, 'old-node').token,
			name: 'old-node',
			publicAddress: '203.0.113.30',
		});
		const db = core.databases.create(owner, { name: 'old-node-db', memoryMb: 128, placement: old.nodeId });
		running(old.nodeId, db.id);
		const beat = (capabilities?: string[]) =>
			core.nodes.heartbeat(old.token, {
				nodeId: old.nodeId,
				agentVersion: '0.1.0',
				actualStateVersion: 1,
				status: 'online',
				caddyOk: true,
				releases: [],
				...(capabilities ? { capabilities } : {}),
			});

		// No heartbeat since capabilities were introduced: unknown, so it keeps preparing.
		expect(core.databaseStudio.view(owner, 'old-node-db').principal).toBe('preparing');

		// An older agent sends no capabilities and would drop the task without a word.
		beat();
		expect(core.databaseStudio.view(owner, 'old-node-db')).toMatchObject({
			principal: 'failed',
			principalError: expect.stringContaining('old-node runs an older Skiff agent'),
		});
		const view = core.databaseStudio.open(owner, 'old-node-db');
		expect(view.principal).toBe('failed');
		expect(failure(() => core.databaseStudio.endpoint(owner, 'old-node-db')).message).toMatch(/older Skiff agent/);

		// Once the node is updated it is waited on again, and connects when it confirms.
		beat(['studio-principal']);
		expect(core.databaseStudio.view(owner, 'old-node-db').principal).toBe('preparing');
		core.databaseStudio.principals.applyResults(old.nodeId, [
			{ databaseId: db.id, generation: generationOf(db.id).generation, status: 'ok' },
		]);
		expect(core.databaseStudio.view(owner, 'old-node-db').principal).toBe('ready');
		core.databaseStudio.close(owner, 'old-node-db');
	});

	test('Valkey/Redis activations carry the password for the generated ACL; other engines do not', async () => {
		const cache = core.databases.get(owner, 'cache-db');
		const password = core.databaseStudio.principals.activation(edgeId, cache.id).password;
		expect(core.workloads.activation(edgeId, cache.id).env.SKIFF_STUDIO_RO_PASSWORD).toBe(password);
		const shop = core.databases.get(owner, 'shop-db');
		expect(core.workloads.activation(edgeId, shop.id).env.SKIFF_STUDIO_RO_PASSWORD).toBeUndefined();
		// Desired state (and so the activation version) never carries it.
		const state = await core.nodes.desiredState(edgeToken);
		expect(JSON.stringify(state)).not.toContain(password);
	});
});

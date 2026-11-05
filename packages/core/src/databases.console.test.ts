import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { databaseConsoleHost, DEFAULT_FEATURES } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-database-console-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(
	join(dir, 'objects'),
	'https://control.test',
	'object-secret-123'
);
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
		features: { ...DEFAULT_FEATURES, ORG_NETWORKS: true }
	}
});

const owner = buildPrincipal({
	kind: 'user',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	platformAdmin: true
});
const viewer = buildPrincipal({
	kind: 'user',
	userId: 'user_2',
	orgId: 'org_1',
	role: 'viewer'
});
// An interactive user who may use the studio but not write through it.
const reader = buildPrincipal({
	kind: 'user',
	userId: 'user_3',
	orgId: 'org_1',
	role: 'deployer',
	granted: ['database:read', 'database:console']
});
// An agent that was explicitly granted the console scope; the service still refuses it.
const agent = buildPrincipal({
	kind: 'mcp',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'deployer',
	granted: ['database:read', 'database:console']
});

let edgeToken = '';
let edgeId = '';
let databaseId = '';

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('on-demand database studio', () => {
	beforeAll(() => {
		const joined = core.nodes.join({
			token: core.nodes.createJoinToken(owner, 'edge').token,
			name: 'edge'
		});
		edgeToken = joined.token;
		edgeId = joined.nodeId;
		databaseId = core.databases.create(owner, {
			name: 'studio-db',
			memoryMb: 128
		}).id;
		core.databases.applyHeartbeat(edgeId, [{ id: databaseId, status: 'running', restarts: 0 }]);
	});

	test('opens as starting, queues a start task and activates the node', async () => {
		const initial = core.databases.console(owner, 'studio-db');
		expect(initial).toMatchObject({
			status: 'stopped',
			active: false,
			readOnly: true,
			port: null,
			expiresAt: null,
			path: '/databases/studio-db/studio/proxy/'
		});
		// The studio permission is never implied by database:read.
		expect(() => core.databases.console(viewer, 'studio-db')).toThrow(/database:console/);

		const opened = core.databases.openConsole(owner, 'studio-db');
		expect(opened).toMatchObject({
			status: 'starting',
			active: true,
			readOnly: true,
			port: 17432,
			idleMinutes: 15,
			lastUsedAt: new Date(clock).toISOString(),
			error: null
		});
		expect(opened.expiresAt).toBe(new Date(clock + 60 * 60_000).toISOString());
		expect(JSON.stringify(opened)).not.toContain('secret');

		const tasks = core.databases.consoleTasksForNode(edgeId);
		expect(tasks).toEqual([{ id: databaseId, action: 'start', generation: 1 }]);

		const activation = core.databases.consoleActivation(edgeId, databaseId);
		expect(activation).toMatchObject({
			databaseId,
			port: 17432,
			webRoot: '/databases/studio-db/studio/proxy',
			readOnly: true,
			authUser: 'skiff'
		});
		expect(activation.authPassword.length).toBeGreaterThanOrEqual(16);
		expect(activation.tls).toBeUndefined();
		expect(() => core.databases.consoleActivation('nod_other', databaseId)).toThrow(/another node/);

		const state = await core.nodes.desiredState(edgeToken);
		expect(state.databaseConsoles).toEqual([{ id: databaseId, action: 'start', generation: 1 }]);
		expect(state.databaseGateway).toEqual({
			listen: '127.0.0.1:8082',
			routes: [{ host: databaseConsoleHost(databaseId), upstream: '127.0.0.1:17432' }]
		});
		expect(JSON.stringify(state)).not.toContain(activation.authPassword);

		core.databases.applyConsoleResults(edgeId, [
			{ id: databaseId, action: 'start', generation: 1, status: 'ok' }
		]);
		expect(core.databases.console(owner, 'studio-db')).toMatchObject({
			status: 'running',
			active: true,
			port: 17432
		});
		expect(core.databases.consoleTasksForNode(edgeId)).toEqual([]);
		expect(
			core.audit.list({ orgId: 'org_1', action: 'database.console.started' }).length
		).toBeGreaterThan(0);

		// Re-opening in the same mode extends the session and keeps the running sidecar.
		clock += 5 * 60_000;
		const extended = core.databases.openConsole(owner, 'studio-db');
		expect(extended.expiresAt).toBe(new Date(clock + 60 * 60_000).toISOString());
		expect(core.databases.consoleTasksForNode(edgeId)).toEqual([]);
	});

	test('serves a proxy endpoint, then closes and applies the stop task', () => {
		const activation = core.databases.consoleActivation(edgeId, databaseId);
		const endpoint = core.databases.consoleEndpoint(owner, 'studio-db');
		expect(endpoint).toMatchObject({
			host: databaseConsoleHost(databaseId),
			webRoot: '/databases/studio-db/studio/proxy',
			readOnly: true,
			expiresAt: new Date(clock + 60 * 60_000).toISOString()
		});
		expect(endpoint.authHeader).toStartWith('Basic ');
		expect(Buffer.from(endpoint.authHeader.slice(6), 'base64').toString()).toBe(
			`skiff:${activation.authPassword}`
		);
		// An API key or agent that was granted the scope still cannot reuse a human's session.
		expect(() => core.databases.consoleEndpoint(agent, 'studio-db')).toThrow(/interactive user/);
		expect(() => core.databases.closeConsole(agent, 'studio-db')).toThrow(/interactive user/);

		const closed = core.databases.closeConsole(owner, 'studio-db');
		expect(closed).toMatchObject({
			status: 'stopped',
			active: false,
			port: null,
			expiresAt: null,
			error: null
		});
		expect(core.databases.consoleTasksForNode(edgeId)).toEqual([
			{ id: databaseId, action: 'stop', generation: 2 }
		]);
		expect(() => core.databases.consoleEndpoint(owner, 'studio-db')).toThrow(/not running/);

		core.databases.applyConsoleResults(edgeId, [
			{ id: databaseId, action: 'stop', generation: 2, status: 'ok' }
		]);
		expect(core.databases.console(owner, 'studio-db')).toMatchObject({
			status: 'stopped',
			active: false
		});
		expect(core.databases.consoleTasksForNode(edgeId)).toEqual([]);
		expect(
			core.audit.list({ orgId: 'org_1', action: 'database.console.stopped' }).length
		).toBeGreaterThan(0);
	});

	test('maintenance closes expired and idle sessions', () => {
		const opened = core.databases.openConsole(owner, 'studio-db');
		expect(opened.status).toBe('starting');
		clock = Date.parse(opened.expiresAt!) + 1_000;
		expect(core.databases.tickConsoles()).toBe(1);
		expect(core.databases.console(owner, 'studio-db')).toMatchObject({
			status: 'stopped',
			active: false
		});
		expect(core.databases.consoleTasksForNode(edgeId)).toEqual([
			{ id: databaseId, action: 'stop', generation: 4 }
		]);
		const expired = core.audit.list({
			orgId: 'org_1',
			action: 'database.console.expired'
		});
		expect(expired.length).toBeGreaterThan(0);
		expect(expired.some((entry) => entry.argsJson?.includes('expired'))).toBe(true);
		// The sweep is idempotent.
		expect(core.databases.tickConsoles()).toBe(0);

		const idle = core.databases.openConsole(owner, 'studio-db', {
			idleMinutes: 5
		});
		clock = Date.parse(idle.lastUsedAt!) + 5 * 60_000 + 1;
		expect(core.databases.tickConsoles()).toBe(1);
		expect(
			core.audit
				.list({
					orgId: 'org_1',
					action: 'database.console.expired'
				})
				.some((entry) => entry.argsJson?.includes('idle'))
		).toBe(true);
	});

	test('write mode needs database:update and the console is interactive only', () => {
		expect(() => core.databases.openConsole(reader, 'studio-db', { readOnly: false })).toThrow(
			/database:update/
		);
		expect(() => core.databases.openConsole(agent, 'studio-db')).toThrow(/interactive user/);

		const readOnly = core.databases.openConsole(reader, 'studio-db');
		expect(readOnly).toMatchObject({ status: 'starting', readOnly: true });
		core.databases.closeConsole(owner, 'studio-db');

		const writable = core.databases.openConsole(owner, 'studio-db', {
			readOnly: false
		});
		expect(writable.readOnly).toBe(false);
		expect(core.databases.consoleActivation(edgeId, databaseId).readOnly).toBe(false);
		core.databases.closeConsole(owner, 'studio-db');
	});

	test('public URL is sealed, metadata-only in views and revealed with credentials', () => {
		core.databases.create(owner, { name: 'public-db', memoryMb: 128 });
		expect(core.databases.get(owner, 'public-db').publicUrl).toEqual({
			configured: false,
			updatedAt: null,
			updatedBy: null
		});

		const url = 'postgres://orders:owner-secret@db.example.com:5432/orders?sslmode=require';
		const saved = core.databases.setPublicUrl(owner, 'public-db', { url });
		expect(saved).toMatchObject({ configured: true, updatedBy: owner.userId });
		expect(saved.updatedAt).not.toBeNull();

		// The URL must not be stored in plaintext, and list/get must not carry it.
		const raw = opened.sqlite
			.query<{ public_url_sealed: string | null }, [string]>(
				'SELECT public_url_sealed FROM databases WHERE name = ?'
			)
			.get('public-db');
		expect(raw?.public_url_sealed).toBeTruthy();
		expect(raw?.public_url_sealed).not.toContain('db.example.com');
		expect(JSON.stringify(core.databases.get(owner, 'public-db'))).not.toContain('db.example.com');

		// A deployer with read but no credentials cannot decrypt it.
		expect(() => core.databases.revealPublicUrl(reader, 'public-db')).toThrow(
			/database:credentials/
		);
		const revealed = core.databases.revealPublicUrl(owner, 'public-db');
		expect(revealed.url).toBe(url);
		expect(
			core.audit.list({ orgId: 'org_1', action: 'database.public-url.reveal' }).length
		).toBeGreaterThan(0);

		const cleared = core.databases.clearPublicUrl(owner, 'public-db');
		expect(cleared.configured).toBe(false);
		expect(() => core.databases.revealPublicUrl(owner, 'public-db')).toThrow(/Public URL/);
	});

	test('deleting a database clears its studio session', () => {
		const database = core.databases.create(owner, { name: 'delete-db', memoryMb: 128 });
		core.databases.applyHeartbeat(edgeId, [{ id: database.id, status: 'running', restarts: 0 }]);
		core.databases.openConsole(owner, 'delete-db');
		const deleted = core.databases.delete(owner, 'delete-db');
		expect(deleted.console).toMatchObject({
			status: 'stopped',
			active: false,
			port: null,
			expiresAt: null
		});
	});

	test('the edge gateway proxies a remote database studio through its public address', async () => {
		const worker = core.nodes.join({
			token: core.nodes.createJoinToken(owner, 'worker').token,
			name: 'worker',
			publicAddress: '203.0.113.20'
		});
		const remote = core.databases.create(owner, {
			name: 'remote-db',
			memoryMb: 128,
			placement: worker.nodeId
		});
		core.databases.applyHeartbeat(worker.nodeId, [
			{ id: remote.id, status: 'running', restarts: 0 }
		]);
		const opened = core.databases.openConsole(owner, 'remote-db');
		expect(opened.port).toBe(17432);

		const edgeState = await core.nodes.desiredState(edgeToken);
		expect(edgeState.databaseGateway.listen).toBe('127.0.0.1:8082');
		expect(edgeState.databaseGateway.routes).toEqual([
			{ host: databaseConsoleHost(remote.id), upstream: 'http://203.0.113.20' }
		]);

		const workerState = await core.nodes.desiredState(worker.token);
		expect(workerState.databaseGateway).toEqual({
			listen: null,
			routes: [{ host: databaseConsoleHost(remote.id), upstream: '127.0.0.1:17432' }]
		});
	});
});

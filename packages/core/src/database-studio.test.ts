import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import {
	databaseStudioActivationSchema,
	databaseStudioHost,
	DEFAULT_FEATURES,
	DEFAULT_STUDIO_LIMITS,
	studioSessionIdPattern,
} from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { studioFingerprint } from './database-studio.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-database-studio-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-06T10:00:00Z');
const features = { ...DEFAULT_FEATURES, ORG_NETWORKS: true, DB_STUDIO: true, DB_TLS: false };

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

// These tests are about sessions: stand in for a node that confirms every read-only principal at
// once (track G has its own tests in database-studio-principal.test.ts).
opened.sqlite.run(`CREATE TRIGGER test_principal_ready AFTER UPDATE OF studio_ro_generation ON databases
	BEGIN UPDATE databases SET studio_ro_ready_generation = NEW.studio_ro_generation WHERE id = NEW.id; END`);

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
// May use the studio but not write through it.
const reader = buildPrincipal({
	kind: 'user',
	userId: 'user_3',
	orgId: 'org_1',
	role: 'deployer',
	granted: ['database:read', 'database:console'],
});
// Explicitly granted the console scope; the service still refuses a non-interactive principal.
const apiKey = buildPrincipal({
	kind: 'apiKey',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	granted: ['database:read', 'database:console', 'database:update'],
});

let edgeToken = '';
let edgeId = '';
let databaseId = '';

function withFlag<T>(enabled: boolean, fn: () => T): T {
	const previous = features.DB_STUDIO;
	features.DB_STUDIO = enabled;
	try {
		return fn();
	} finally {
		features.DB_STUDIO = previous;
	}
}

function closeAll(): void {
	opened.sqlite.run(
		"UPDATE database_studio_sessions SET closed_at = ?, close_reason = 'closed' WHERE closed_at IS NULL",
		[clock],
	);
}

/** The Core error a call throws, so tests can assert its HTTP status. */
function failure(fn: () => unknown): { status: number; message: string } {
	try {
		fn();
	} catch (error) {
		return error as { status: number; message: string };
	}
	throw new Error('expected the call to throw');
}

function auditArgs(action: string): Array<Record<string, unknown>> {
	return core.audit
		.list({ orgId: 'org_1', action, limit: 500 })
		.map((entry) => JSON.parse(entry.argsJson ?? '{}') as Record<string, unknown>);
}

afterEach(() => closeAll());

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('native database studio sessions', () => {
	beforeAll(() => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		edgeToken = joined.token;
		edgeId = joined.nodeId;
		databaseId = core.databases.create(owner, { name: 'studio-db', memoryMb: 128 }).id;
		core.databases.applyHeartbeat(edgeId, [{ id: databaseId, status: 'running', restarts: 0 }]);
	});

	test('opens, extends in the same mode and replaces the session on a mode change', () => {
		expect(core.databaseStudio.view(owner, 'studio-db')).toEqual({
			sessionId: null,
			active: false,
			readOnly: true,
			expiresAt: null,
			idleMinutes: 15,
			lastUsedAt: null,
			path: '/databases/studio-db/studio',
			principal: 'ready',
			principalError: null,
		});

		const first = core.databaseStudio.open(owner, 'studio-db');
		expect(first).toMatchObject({ active: true, readOnly: true, idleMinutes: 15 });
		expect(first.sessionId).toMatch(studioSessionIdPattern);
		expect(first.expiresAt).toBe(new Date(clock + 60 * 60_000).toISOString());

		// The token is stored sealed, never in plaintext.
		const raw = opened.sqlite
			.query<{ token_sealed: string }, [string]>('SELECT token_sealed FROM database_studio_sessions WHERE id = ?')
			.get(first.sessionId!);
		const token = core.databaseStudio.endpoint(owner, 'studio-db').token;
		expect(Buffer.from(token, 'base64url').length).toBe(32);
		expect(raw?.token_sealed).toBeTruthy();
		expect(raw?.token_sealed).not.toContain(token);

		clock += 5 * 60_000;
		const extended = core.databaseStudio.open(owner, 'studio-db', { idleMinutes: 30 });
		expect(extended.sessionId).toBe(first.sessionId);
		expect(extended.idleMinutes).toBe(30);
		expect(extended.expiresAt).toBe(new Date(clock + 60 * 60_000).toISOString());
		expect(core.databaseStudio.endpoint(owner, 'studio-db').token).toBe(token);

		const writable = core.databaseStudio.open(owner, 'studio-db', { readOnly: false });
		expect(writable.sessionId).not.toBe(first.sessionId);
		expect(writable.readOnly).toBe(false);
		expect(core.databaseStudio.endpoint(owner, 'studio-db').token).not.toBe(token);
		const old = opened.sqlite
			.query<{ close_reason: string | null }, [string]>(
				'SELECT close_reason FROM database_studio_sessions WHERE id = ?',
			)
			.get(first.sessionId!);
		expect(old?.close_reason).toBe('mode-change');

		const opens = auditArgs('database.console.open');
		expect(opens.length).toBe(3);
		expect(opens.every((args) => args.studio === 'native')).toBe(true);
		expect(auditArgs('database.console.close').some((args) => args.reason === 'mode-change')).toBe(true);

		const closed = core.databaseStudio.close(owner, 'studio-db');
		expect(closed).toMatchObject({ sessionId: null, active: false, expiresAt: null });
		expect(() => core.databaseStudio.endpoint(owner, 'studio-db')).toThrow(/not open/);
	});

	test('enforces permissions, the flag and interactive sessions', () => {
		expect(() => core.databaseStudio.view(viewer, 'studio-db')).toThrow(/database:console/);
		expect(() => core.databaseStudio.open(viewer, 'studio-db')).toThrow(/database:console/);
		expect(() => core.databaseStudio.open(reader, 'studio-db', { readOnly: false })).toThrow(/database:update/);
		expect(() => core.databaseStudio.open(apiKey, 'studio-db')).toThrow(/interactive user/);
		expect(() => core.databaseStudio.endpoint(apiKey, 'studio-db')).toThrow(/interactive user/);
		withFlag(false, () => {
			expect(() => core.databaseStudio.open(owner, 'studio-db')).toThrow(
				'The native database studio is disabled on this control plane.',
			);
		});

		const readOnly = core.databaseStudio.open(reader, 'studio-db');
		expect(readOnly).toMatchObject({ active: true, readOnly: true });
		// Sessions are per user: the owner does not see the reader's session.
		expect(core.databaseStudio.view(owner, 'studio-db').active).toBe(false);
		withFlag(false, () => {
			expect(() => core.databaseStudio.endpoint(reader, 'studio-db')).toThrow(/disabled/);
		});
		core.databaseStudio.close(reader, 'studio-db');
	});

	test('refuses a database that is not running or lacks the console capability', () => {
		core.databases.create(owner, { name: 'cold-db', memoryMb: 128 });
		expect(() => core.databaseStudio.open(owner, 'cold-db')).toThrow(/Start it and wait until it is running/);
	});

	test('endpoint returns the token and the view never does', () => {
		const view = core.databaseStudio.open(owner, 'studio-db');
		const endpoint = core.databaseStudio.endpoint(owner, 'studio-db');
		expect(endpoint).toMatchObject({
			sessionId: view.sessionId,
			host: databaseStudioHost(edgeId),
			nodeId: edgeId,
			engine: 'postgres',
			readOnly: true,
			expiresAt: view.expiresAt,
		});
		expect(endpoint.token.length).toBeGreaterThanOrEqual(40);
		expect(JSON.stringify(core.databaseStudio.view(owner, 'studio-db'))).not.toContain(endpoint.token);
		expect(JSON.stringify(view)).not.toContain(endpoint.token);
		expect(JSON.stringify(core.audit.list({ orgId: 'org_1', limit: 500 }))).not.toContain(endpoint.token);

		// Last-used is coalesced to one write a minute.
		const lastUsed = core.databaseStudio.view(owner, 'studio-db').lastUsedAt;
		clock += 30_000;
		core.databaseStudio.endpoint(owner, 'studio-db');
		expect(core.databaseStudio.view(owner, 'studio-db').lastUsedAt).toBe(lastUsed);
		clock += 31_000;
		core.databaseStudio.endpoint(owner, 'studio-db');
		expect(core.databaseStudio.view(owner, 'studio-db').lastUsedAt).toBe(new Date(clock).toISOString());

		// An expired session is closed and refused.
		clock = Date.parse(view.expiresAt!) + 1;
		expect(() => core.databaseStudio.endpoint(owner, 'studio-db')).toThrow(
			'The database studio session has expired. Open it again.',
		);
		expect(core.databaseStudio.view(owner, 'studio-db').active).toBe(false);
		expect(core.databaseStudio.tick()).toBe(0);
	});

	test('activation checks node, token, state and returns the connection payload', async () => {
		const view = core.databaseStudio.open(owner, 'studio-db');
		const { sessionId, token } = core.databaseStudio.endpoint(owner, 'studio-db');
		expect(sessionId).toBe(view.sessionId!);

		const activation = core.databaseStudio.activation(edgeId, sessionId, token);
		expect(databaseStudioActivationSchema.parse(activation)).toEqual(activation);
		const credentials = core.databases.credentials(owner, 'studio-db');
		const readOnly = core.databaseStudio.principals.activation(edgeId, databaseId);
		expect(activation).toEqual({
			v: 1,
			sessionId,
			databaseId,
			engine: 'postgres',
			version: core.databases.get(owner, 'studio-db').version,
			host: '127.0.0.1',
			port: credentials.port,
			database: 'studio_db',
			// A read-only session connects as the read-only principal, never the owner.
			user: 'yoal_studio_ro',
			password: readOnly.password,
			tls: null,
			readOnly: true,
			limits: DEFAULT_STUDIO_LIMITS,
			expiresAt: view.expiresAt!,
		});

		expect(failure(() => core.databaseStudio.activation('node_other', sessionId, token)).status).toBe(403);
		expect(failure(() => core.databaseStudio.activation(edgeId, sessionId, `${token}x`))).toMatchObject({ status: 403, message: expect.stringMatching(/token/) });
		expect(failure(() => core.databaseStudio.activation(edgeId, 'dss_doesnotexist000000000', token)).status).toBe(404);
		withFlag(false, () => {
			expect(() => core.databaseStudio.activation(edgeId, sessionId, token)).toThrow(/disabled/);
		});

		// Desired state carries the session id and port, never the token or the password.
		const state = await core.nodes.desiredState(edgeToken);
		expect(state.studio).toEqual({ port: 8083, sessions: [sessionId] });
		expect(JSON.stringify(state)).not.toContain(token);
		expect(JSON.stringify(state)).not.toContain(credentials.password);
		expect(JSON.stringify(state)).not.toContain(readOnly.password);

		clock = Date.parse(view.expiresAt!) + 1;
		expect(failure(() => core.databaseStudio.activation(edgeId, sessionId, token))).toMatchObject({ status: 409, message: expect.stringMatching(/expired/) });

		const reopened = core.databaseStudio.open(owner, 'studio-db');
		const next = core.databaseStudio.endpoint(owner, 'studio-db');
		core.databaseStudio.close(owner, 'studio-db');
		expect(failure(() => core.databaseStudio.activation(edgeId, reopened.sessionId!, next.token))).toMatchObject({ status: 409, message: expect.stringMatching(/closed/) });
	});

	test('activation picks the database per engine and passes the TLS CA', () => {
		const valkey = core.databases.create(owner, { name: 'cache-db', memoryMb: 128, engine: 'valkey' });
		const mongo = core.databases.create(owner, { name: 'docs-db', memoryMb: 256, engine: 'mongodb' });
		core.databases.applyHeartbeat(edgeId, [
			{ id: valkey.id, status: 'running', restarts: 0 },
			{ id: mongo.id, status: 'running', restarts: 0 },
		]);
		core.databaseStudio.open(owner, 'cache-db');
		const cache = core.databaseStudio.endpoint(owner, 'cache-db');
		expect(core.databaseStudio.activation(edgeId, cache.sessionId, cache.token)).toMatchObject({
			engine: 'valkey',
			database: '0',
			user: 'yoal_studio_ro',
		});
		core.databaseStudio.open(owner, 'docs-db');
		const docs = core.databaseStudio.endpoint(owner, 'docs-db');
		expect(core.databaseStudio.activation(edgeId, docs.sessionId, docs.token)).toMatchObject({
			engine: 'mongodb',
			database: 'docs_db',
		});

		// Postgres pins the helper CA once the node reports it.
		core.databaseStudio.open(owner, 'studio-db');
		const pg = core.databaseStudio.endpoint(owner, 'studio-db');
		features.DB_TLS = true;
		try {
			core.databases.applyTlsReport(edgeId, [{ id: databaseId, enabled: true, caPem: 'CA-PEM' }]);
			expect(core.databaseStudio.activation(edgeId, pg.sessionId, pg.token).tls).toEqual({ caPem: 'CA-PEM' });
		} finally {
			features.DB_TLS = false;
		}
	});

	test('desired state and gateway routes for edge and worker', async () => {
		const worker = core.nodes.join({
			token: core.nodes.createJoinToken(owner, 'worker').token,
			name: 'worker',
			publicAddress: '203.0.113.20',
		});
		const remote = core.databases.create(owner, { name: 'remote-db', memoryMb: 128, placement: worker.nodeId });
		core.databases.applyHeartbeat(worker.nodeId, [{ id: remote.id, status: 'running', restarts: 0 }]);

		expect(core.databaseStudio.desiredForNode(edgeId)).toEqual({ port: 8083, sessions: [] });
		// Routes exist from placement, before the first session opens: opening a session bumps
		// desired state, and a route derived from it would not be on the node when the browser's
		// first call arrives (Caddy answers an unmatched route with an empty 200).
		expect(core.databaseStudio.gatewayRoutes(edgeId, true, () => '203.0.113.20')).toEqual(
			[
				{ host: databaseStudioHost(edgeId), upstream: '127.0.0.1:8083' },
				{ host: databaseStudioHost(worker.nodeId), upstream: 'http://203.0.113.20' },
			].sort((a, b) => a.host.localeCompare(b.host)),
		);
		expect(core.databaseStudio.gatewayRoutes(worker.nodeId, false, () => '203.0.113.20')).toEqual([
			{ host: databaseStudioHost(worker.nodeId), upstream: '127.0.0.1:8083' },
		]);

		const local = core.databaseStudio.open(owner, 'studio-db');
		const far = core.databaseStudio.open(owner, 'remote-db');
		expect(core.databaseStudio.desiredForNode(edgeId)?.sessions).toEqual([local.sessionId!]);
		expect(core.databaseStudio.desiredForNode(worker.nodeId)?.sessions).toEqual([far.sessionId!]);

		const edgeRoutes = [
			{ host: databaseStudioHost(edgeId), upstream: '127.0.0.1:8083' },
			{ host: databaseStudioHost(worker.nodeId), upstream: 'http://203.0.113.20' },
		].sort((a, b) => a.host.localeCompare(b.host));
		const edgeState = await core.nodes.desiredState(edgeToken);
		expect(edgeState.databaseGateway).toEqual({ listen: '127.0.0.1:8082', routes: edgeRoutes });
		expect(edgeState.studio).toEqual({ port: 8083, sessions: [local.sessionId!] });

		const workerState = await core.nodes.desiredState(worker.token);
		expect(workerState.databaseGateway).toEqual({
			listen: null,
			routes: [{ host: databaseStudioHost(worker.nodeId), upstream: '127.0.0.1:8083' }],
		});
		expect(workerState.studio).toEqual({ port: 8083, sessions: [far.sessionId!] });

		// D96: desired state no longer carries D60 console tasks.
		expect('databaseConsoles' in workerState).toBe(false);

		withFlag(false, () => {
			expect(core.databaseStudio.desiredForNode(edgeId)).toBeNull();
			expect(core.databaseStudio.gatewayRoutes(edgeId, true, () => '203.0.113.20')).toEqual([]);
		});
	});

	test('maintenance closes expired and idle sessions', () => {
		const opened = core.databaseStudio.open(owner, 'studio-db');
		clock = Date.parse(opened.expiresAt!) + 1_000;
		expect(core.databaseStudio.tick()).toBe(1);
		expect(core.databaseStudio.view(owner, 'studio-db').active).toBe(false);
		expect(auditArgs('database.console.expired').some((args) => args.reason === 'expired')).toBe(true);
		expect(core.databaseStudio.tick()).toBe(0);

		const idle = core.databaseStudio.open(owner, 'studio-db', { idleMinutes: 5 });
		clock += 5 * 60_000 - 1;
		expect(core.databaseStudio.tick()).toBe(0);
		clock += 1;
		expect(core.databaseStudio.tick()).toBe(1);
		const expired = auditArgs('database.console.expired');
		expect(expired.some((args) => args.reason === 'idle' && args.studio === 'native')).toBe(true);
		expect(core.databaseStudio.view(owner, 'studio-db').sessionId).toBeNull();
		expect(idle.sessionId).not.toBeNull();
	});

	test('trashing a database closes its sessions', async () => {
		const database = core.databases.create(owner, { name: 'trash-db', memoryMb: 128, placement: edgeId });
		core.databases.applyHeartbeat(edgeId, [{ id: database.id, status: 'running', restarts: 0 }]);
		const view = core.databaseStudio.open(owner, 'trash-db');
		const { token } = core.databaseStudio.endpoint(owner, 'trash-db');
		core.databases.delete(owner, 'trash-db');
		expect(core.databaseStudio.view(owner, 'trash-db').active).toBe(false);
		expect(core.databaseStudio.desiredForNode(edgeId)?.sessions).not.toContain(view.sessionId!);
		expect(failure(() => core.databaseStudio.activation(edgeId, view.sessionId!, token)).status).toBe(404);
		expect(auditArgs('database.console.close').some((args) => args.reason === 'deleted')).toBe(true);
		expect(() => core.databaseStudio.open(owner, 'trash-db')).toThrow(/in the trash/);
	});

	test('records runs and writes by fingerprint and counts only', () => {
		const input = "SELECT * FROM users WHERE email = 'a@example.com' AND id = 42 -- lookup";
		const fingerprint = studioFingerprint(input);
		core.databaseStudio.recordActivity(owner, 'studio-db', { op: 'run', fingerprint, readOnly: true });
		core.databaseStudio.recordActivity(owner, 'studio-db', {
			op: 'apply',
			object: 'public.users',
			inserted: 1,
			updated: 2,
			deleted: 0,
			applied: 3,
		});
		expect(auditArgs('database.studio.run')).toEqual([{ name: 'studio-db', fingerprint, readOnly: true }]);
		core.databaseStudio.recordActivity(owner, 'studio-db', {
			op: 'apply',
			object: { path: ['public', 'orders'], kind: 'table' },
			inserted: 0,
			updated: 1,
			deleted: 0,
			applied: 1,
		});
		const writes = auditArgs('database.studio.write');
		expect(writes).toContainEqual({
			name: 'studio-db',
			object: 'public.users',
			inserted: 1,
			updated: 2,
			deleted: 0,
			applied: 3,
		});
		expect(writes).toContainEqual({
			name: 'studio-db',
			object: 'public.orders',
			kind: 'table',
			inserted: 0,
			updated: 1,
			deleted: 0,
			applied: 1,
		});
		core.databaseStudio.recordActivity(owner, 'studio-db', {
			op: 'alter',
			object: ['public', 'orders'],
			change: 'add-column',
		});
		expect(auditArgs('database.studio.alter')).toEqual([
			{ name: 'studio-db', object: 'public.orders', change: 'add-column' },
		]);
		expect(() =>
			core.databaseStudio.recordActivity(owner, 'studio-db', { op: 'run', fingerprint: input, readOnly: true }),
		).toThrow(/fingerprint/);
		expect(JSON.stringify(core.audit.list({ orgId: 'org_1', limit: 500 }))).not.toContain('a@example.com');
	});

	test('studioFingerprint normalises literals, comments, whitespace and case', () => {
		const base = studioFingerprint("SELECT * FROM users WHERE email = 'a@example.com' AND id = 42");
		expect(base).toMatch(/^[0-9a-f]{16}$/);
		expect(studioFingerprint("select *\n  from users -- who\nwhere email = 'b''c' and id = 7")).toBe(base);
		expect(studioFingerprint("/* x */ SELECT * FROM users WHERE email = $$z$$ AND id = 3.5e2")).toBe(base);
		expect(studioFingerprint("SELECT * FROM users WHERE email = '-- not a comment' AND id = 0x1F")).toBe(base);
		expect(studioFingerprint('SELECT * FROM orders WHERE email = ? AND id = ?')).not.toBe(base);
		// Digits inside identifiers are not literals.
		expect(studioFingerprint('select col1 from t2')).not.toBe(studioFingerprint('select col3 from t4'));
		expect(studioFingerprint('db.users.find({"email": "a@b"})')).toBe(studioFingerprint('db.users.find({"email": "c@d"})'));
	});

	test('a database-scoped binding covers only that database', () => {
		const visible = core.databases.create(owner, { name: 'scoped-studio-visible', memoryMb: 128 });
		const hidden = core.databases.create(owner, { name: 'scoped-studio-hidden', memoryMb: 128 });
		// Inserted directly so iamVersion stays 0 and the owner in the rest of this file keeps its
		// legacy org-wide grants.
		opened.sqlite.run(
			`INSERT INTO iam_bindings
			   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, created_by, created_at)
			 VALUES ('bind_guest_studio', 'org_1', 'user', 'user_guest_studio', 'deployer', 'database', ?, 'test', 0)`,
			[visible.id],
		);
		const guest = buildPrincipal({
			kind: 'user',
			userId: 'user_guest_studio',
			orgId: 'org_1',
			role: 'viewer',
		});

		expect(core.databaseStudio.view(guest, visible.name).active).toBe(false);
		expect(() => core.databaseStudio.view(guest, hidden.name)).toThrow(/database:read/);
		core.databaseStudio.recordActivity(guest, visible.name, {
			op: 'run',
			fingerprint: '0123456789abcdef',
			readOnly: true,
		});
		expect(() =>
			core.databaseStudio.recordActivity(guest, hidden.name, {
				op: 'run',
				fingerprint: '0123456789abcdef',
				readOnly: true,
			}),
		).toThrow(/database:console/);
	});
});

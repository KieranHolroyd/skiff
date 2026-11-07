import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createDb } from '@skiff/db';
import type { Role } from '@skiff/contracts';
import { AuditService } from './audit.ts';
import { ConnectedAppService, authDate, authList } from './connected-apps.ts';
import type { CoreContext } from './context.ts';
import { buildPrincipal } from './orgs.ts';

const opened = createDb({ path: ':memory:' });
const sqlite = opened.sqlite;
let clock = Date.parse('2026-11-07T12:00:00.000Z');

// Only what the service touches: the database, the clock and the audit log.
const ctx = { db: opened.db, sqlite, now: () => clock } as unknown as CoreContext;
ctx.audit = new AuditService(ctx);
const core = { connectedApps: new ConnectedAppService(ctx) };

// The Better Auth tables these queries read, as its SQLite adapter creates them (columns used here).
sqlite.exec(`
	CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, name TEXT, email TEXT, role TEXT);
	CREATE TABLE IF NOT EXISTS organization (id TEXT PRIMARY KEY, name TEXT, slug TEXT, createdAt TEXT);
	CREATE TABLE IF NOT EXISTS member (id TEXT PRIMARY KEY, organizationId TEXT, userId TEXT, role TEXT, createdAt TEXT);
	CREATE TABLE oauthClient (id TEXT PRIMARY KEY, clientId TEXT UNIQUE, name TEXT, uri TEXT, icon TEXT, redirectUris TEXT NOT NULL DEFAULT '[]');
	CREATE TABLE oauthConsent (id TEXT PRIMARY KEY, clientId TEXT NOT NULL, userId TEXT, referenceId TEXT, scopes TEXT NOT NULL, createdAt DATE NOT NULL, updatedAt DATE NOT NULL);
	CREATE TABLE oauthRefreshToken (id TEXT PRIMARY KEY, token TEXT UNIQUE, clientId TEXT NOT NULL, userId TEXT NOT NULL, expiresAt DATE NOT NULL, createdAt DATE NOT NULL, revoked DATE, scopes TEXT NOT NULL);
	CREATE TABLE oauthAccessToken (id TEXT PRIMARY KEY, token TEXT UNIQUE, clientId TEXT NOT NULL, userId TEXT, expiresAt DATE NOT NULL, createdAt DATE NOT NULL, scopes TEXT NOT NULL);
`);

const iso = (ms: number) => new Date(ms).toISOString();
const principal = (userId: string, role: Role, orgId = 'org_a') => buildPrincipal({ kind: 'user', userId, orgId, role });

function member(userId: string, role: Role, orgId = 'org_a') {
	sqlite.run('INSERT INTO user (id, name, email) VALUES (?, ?, ?)', [userId, `User ${userId}`, `${userId}@example.com`]);
	sqlite.run('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)', [
		`m_${userId}`,
		orgId,
		userId,
		role,
		iso(clock),
	]);
}

function grant(id: string, userId: string, clientId: string, at = clock) {
	sqlite.run('INSERT INTO oauthConsent (id, clientId, userId, scopes, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)', [
		id,
		clientId,
		userId,
		JSON.stringify(['openid', 'offline_access', 'project:read']),
		iso(at),
		iso(at),
	]);
	sqlite.run('INSERT INTO oauthRefreshToken (id, token, clientId, userId, expiresAt, createdAt, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)', [
		`rt_${id}`,
		`token_${id}`,
		clientId,
		userId,
		iso(at + 30 * 86_400_000),
		iso(at),
		'["openid"]',
	]);
	sqlite.run('INSERT INTO oauthAccessToken (id, token, clientId, userId, expiresAt, createdAt, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)', [
		`at_${id}`,
		`opaque_${id}`,
		clientId,
		userId,
		iso(at + 3_600_000),
		iso(at),
		'["openid"]',
	]);
}

beforeEach(() => {
	for (const table of ['user', 'member', 'oauthClient', 'oauthConsent', 'oauthRefreshToken', 'oauthAccessToken', 'oauth_client_usage', 'audit_log'])
		sqlite.run(`DELETE FROM ${table}`);
	member('owner', 'owner');
	member('admin', 'admin');
	member('dev', 'deployer');
	member('outsider', 'owner', 'org_b');
	sqlite.run("INSERT INTO oauthClient (id, clientId, name, uri) VALUES ('c1', 'dcr-client', 'Claude Code', 'https://claude.ai')");
	sqlite.run("INSERT INTO oauthClient (id, clientId, name) VALUES ('c2', 'https://agent.example/client.json', 'Agent')");
});

afterAll(() => sqlite.close());

describe('list', () => {
	test('shows the caller only their own grants, with client details and scopes', () => {
		grant('g1', 'dev', 'dcr-client');
		grant('g2', 'owner', 'dcr-client');
		const apps = core.connectedApps.list(principal('dev', 'deployer'));
		expect(apps).toHaveLength(1);
		expect(apps[0]).toMatchObject({
			id: 'g1',
			clientId: 'dcr-client',
			name: 'Claude Code',
			registration: 'registered',
			scopes: ['openid', 'offline_access', 'project:read'],
			activeRefreshTokens: 1,
			user: { id: 'dev', email: 'dev@example.com', role: 'deployer' },
		});
		expect(apps[0]!.createdAt).toBe(clock);
	});

	test('marks CIMD clients and prefers the last MCP call over the last refresh', () => {
		grant('g1', 'dev', 'https://agent.example/client.json');
		expect(core.connectedApps.list(principal('dev', 'deployer'))[0]).toMatchObject({
			registration: 'metadata-document',
			lastUsedAt: clock,
		});
		clock += 5 * 60_000;
		core.connectedApps.touch('dev', 'https://agent.example/client.json');
		expect(core.connectedApps.list(principal('dev', 'deployer'))[0]!.lastUsedAt).toBe(clock);
	});

	test('org view needs member:remove and stays inside the organisation', () => {
		grant('g1', 'dev', 'dcr-client');
		grant('g2', 'owner', 'dcr-client');
		grant('g3', 'outsider', 'dcr-client');
		expect(() => core.connectedApps.list(principal('dev', 'deployer'), { scope: 'org' })).toThrow(/member:remove/);
		const ids = core.connectedApps.list(principal('admin', 'admin'), { scope: 'org' }).map((app) => app.id);
		expect(ids.sort()).toEqual(['g1', 'g2']);
	});

	test('merges several consents for the same client into one entry', () => {
		grant('g1', 'dev', 'dcr-client');
		sqlite.run("INSERT INTO oauthConsent (id, clientId, userId, referenceId, scopes, createdAt, updatedAt) VALUES ('g1b', 'dcr-client', 'dev', 'ref', '[\"logs:read\"]', ?, ?)", [
			iso(clock + 1000),
			iso(clock + 1000),
		]);
		const apps = core.connectedApps.list(principal('dev', 'deployer'));
		expect(apps).toHaveLength(1);
		expect(apps[0]!.scopes).toEqual(['openid', 'offline_access', 'project:read', 'logs:read']);
	});
});

describe('revoke', () => {
	test('removes the consent, refresh and access tokens, and records it', async () => {
		grant('g1', 'dev', 'dcr-client');
		core.connectedApps.touch('dev', 'dcr-client');
		const result = await core.connectedApps.revoke(principal('dev', 'deployer'), 'g1');
		expect(result).toEqual({ revoked: true, clientId: 'dcr-client', userId: 'dev', refreshTokens: 1 });
		for (const table of ['oauthConsent', 'oauthRefreshToken', 'oauthAccessToken', 'oauth_client_usage'])
			expect(sqlite.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
		const audit = sqlite.query<{ action: string; resource_id: string; actor_id: string }, []>('SELECT action, resource_id, actor_id FROM audit_log').all();
		expect(audit).toEqual([{ action: 'connected_app.revoke', resource_id: 'dcr-client', actor_id: 'dev' }]);
	});

	test("a member cannot revoke someone else's grant", async () => {
		grant('g1', 'owner', 'dcr-client');
		await expect(core.connectedApps.revoke(principal('dev', 'deployer'), 'g1')).rejects.toThrow(/member:remove/);
		expect(core.connectedApps.grantActive('owner', 'dcr-client')).toBe(true);
	});

	test("admins revoke members' grants, but only an owner revokes an owner's", async () => {
		grant('g1', 'dev', 'dcr-client');
		grant('g2', 'owner', 'dcr-client');
		await core.connectedApps.revoke(principal('admin', 'admin'), 'g1');
		expect(core.connectedApps.grantActive('dev', 'dcr-client')).toBe(false);
		await expect(core.connectedApps.revoke(principal('admin', 'admin'), 'g2')).rejects.toMatchObject({ status: 403 });
		member('owner2', 'owner');
		await core.connectedApps.revoke(principal('owner2', 'owner'), 'g2');
		expect(core.connectedApps.grantActive('owner', 'dcr-client')).toBe(false);
	});

	test("another organisation's grant is not found", async () => {
		grant('g1', 'outsider', 'dcr-client');
		await expect(core.connectedApps.revoke(principal('admin', 'admin'), 'g1')).rejects.toMatchObject({ status: 404 });
		await expect(core.connectedApps.revoke(principal('admin', 'admin'), 'missing')).rejects.toMatchObject({ status: 404 });
	});
});

describe('grantActive', () => {
	test('a token is honoured only while a grant no newer than the token exists', async () => {
		const issuedAt = Math.floor(clock / 1000);
		grant('g1', 'dev', 'dcr-client');
		expect(core.connectedApps.grantActive('dev', 'dcr-client', issuedAt)).toBe(true);
		expect(core.connectedApps.grantActive('dev', 'other-client', issuedAt)).toBe(false);
		await core.connectedApps.revoke(principal('dev', 'deployer'), 'g1');
		expect(core.connectedApps.grantActive('dev', 'dcr-client', issuedAt)).toBe(false);
		// Approving the client again does not revive the token issued before the revocation.
		grant('g2', 'dev', 'dcr-client', clock + 60_000);
		expect(core.connectedApps.grantActive('dev', 'dcr-client', issuedAt)).toBe(false);
		expect(core.connectedApps.grantActive('dev', 'dcr-client', issuedAt + 60)).toBe(true);
	});
});

describe('Better Auth column formats', () => {
	test('dates and lists', () => {
		expect(authDate('2026-11-03T19:36:16.000Z')).toBe(Date.parse('2026-11-03T19:36:16.000Z'));
		expect(authDate(1_700_000_000_000)).toBe(1_700_000_000_000);
		expect(authDate('1700000000000')).toBe(1_700_000_000_000);
		expect(authDate(null)).toBeNull();
		expect(authList('["a","b"]')).toEqual(['a', 'b']);
		expect(authList('a b,c')).toEqual(['a', 'b', 'c']);
		expect(authList(null)).toEqual([]);
	});
});

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { canAdministerPlatform, canViewPlatform } from '@skiff/contracts';
import { buildPrincipal, isPlatformAdminUser, resolveMembership } from './orgs.ts';

function authDb() {
	const sqlite = new Database(':memory:');
	sqlite.run('CREATE TABLE user (id TEXT PRIMARY KEY, role TEXT)');
	sqlite.run('CREATE TABLE organization (id TEXT PRIMARY KEY, name TEXT, slug TEXT, createdAt TEXT)');
	sqlite.run('CREATE TABLE member (id TEXT PRIMARY KEY, organizationId TEXT, userId TEXT, role TEXT, createdAt TEXT)');
	return sqlite;
}

describe('resolveMembership', () => {
	test('the bootstrap user gets a personal owner org', () => {
		const sqlite = authDb();
		expect(resolveMembership(sqlite, 'u1')?.role).toBe('owner');
	});

	test('later users on an invite-only install get no org of their own', () => {
		const sqlite = authDb();
		resolveMembership(sqlite, 'u1');
		expect(resolveMembership(sqlite, 'invitee')).toBeUndefined();
		expect(sqlite.query('SELECT count(*) AS n FROM organization').get()).toEqual({ n: 1 });
	});

	test('open signup still creates personal orgs', () => {
		const sqlite = authDb();
		resolveMembership(sqlite, 'u1');
		expect(resolveMembership(sqlite, 'u2', { openSignup: true })?.role).toBe('owner');
	});

	test('an invited member resolves to their invited org and role', () => {
		const sqlite = authDb();
		const owner = resolveMembership(sqlite, 'u1')!;
		sqlite.run("INSERT INTO member VALUES ('m2', ?, 'u2', 'deployer', ?)", [owner.orgId, new Date().toISOString()]);
		expect(resolveMembership(sqlite, 'u2')).toEqual({ orgId: owner.orgId, role: 'deployer' });
	});
});

describe('platform admin', () => {
	test('comes from the admin-plugin user role, not the org role', () => {
		const sqlite = authDb();
		sqlite.run("INSERT INTO user VALUES ('admin', 'admin'), ('multi', 'user,admin'), ('owner', 'user'), ('none', NULL)");
		expect(isPlatformAdminUser(sqlite, 'admin')).toBe(true);
		expect(isPlatformAdminUser(sqlite, 'multi')).toBe(true);
		expect(isPlatformAdminUser(sqlite, 'owner')).toBe(false);
		expect(isPlatformAdminUser(sqlite, 'none')).toBe(false);
		expect(isPlatformAdminUser(sqlite, 'missing')).toBe(false);
	});

	test('org owners are not platform admins', () => {
		const owner = buildPrincipal({ kind: 'user', userId: 'u', orgId: 'o', role: 'owner' });
		expect(canViewPlatform(owner)).toBe(false);
		expect(canAdministerPlatform(owner)).toBe(false);
	});

	test('API keys and MCP tokens of a platform admin can read but not mutate the fleet', () => {
		for (const kind of ['apiKey', 'mcp'] as const) {
			const key = buildPrincipal({ kind, userId: 'u', orgId: 'o', role: 'owner', platformAdmin: true, granted: ['project:read'] });
			expect(canViewPlatform(key)).toBe(true);
			expect(canAdministerPlatform(key)).toBe(false);
		}
		const session = buildPrincipal({ kind: 'user', userId: 'u', orgId: 'o', role: 'viewer', platformAdmin: true });
		expect(canAdministerPlatform(session)).toBe(true);
	});
});

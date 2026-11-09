import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { canAdministerPlatform, canViewPlatform } from '@skiff/contracts';
import { buildPrincipal, isPlatformAdminUser, isRole, memberChangeError, resolveMembership } from './orgs.ts';

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

describe('memberChangeError', () => {
	test('only owners invite owners', () => {
		expect(memberChangeError('admin', { action: 'invite', role: 'owner' }, 1)).toBeDefined();
		expect(memberChangeError('admin', { action: 'invite', role: 'deployer' }, 1)).toBeUndefined();
		expect(memberChangeError('owner', { action: 'invite', role: 'owner' }, 1)).toBeUndefined();
	});

	test('only owners grant or change the owner role', () => {
		expect(memberChangeError('admin', { action: 'update-role', targetRole: 'viewer', role: 'owner', self: false }, 1)).toBeDefined();
		expect(memberChangeError('admin', { action: 'update-role', targetRole: 'owner', role: 'admin', self: false }, 2)).toBeDefined();
		expect(memberChangeError('admin', { action: 'update-role', targetRole: 'viewer', role: 'deployer', self: false }, 1)).toBeUndefined();
		expect(memberChangeError('owner', { action: 'update-role', targetRole: 'admin', role: 'owner', self: false }, 1)).toBeUndefined();
	});

	test('the last owner cannot be demoted or removed', () => {
		expect(memberChangeError('owner', { action: 'update-role', targetRole: 'owner', role: 'admin', self: true }, 1)).toContain('at least one owner');
		expect(memberChangeError('owner', { action: 'update-role', targetRole: 'owner', role: 'admin', self: true }, 2)).toBeUndefined();
		expect(memberChangeError('owner', { action: 'remove', targetRole: 'owner', self: false }, 1)).toContain('at least one owner');
		expect(memberChangeError('owner', { action: 'remove', targetRole: 'owner', self: false }, 2)).toBeUndefined();
	});

	test('no-op role changes and self-removal are refused', () => {
		expect(memberChangeError('owner', { action: 'update-role', targetRole: 'viewer', role: 'viewer', self: false }, 1)).toBeDefined();
		expect(memberChangeError('owner', { action: 'remove', targetRole: 'deployer', self: true }, 2)).toBeDefined();
		expect(memberChangeError('admin', { action: 'remove', targetRole: 'owner', self: false }, 2)).toBeDefined();
	});

	test('guest membership is project-only (IAM.md §8.2)', () => {
		expect(isRole('guest')).toBe(true);
		// A guest is created by a project invitation, never by an org invite.
		expect(memberChangeError('owner', { action: 'invite', role: 'guest' }, 1)).toContain('project');
		// Promoting a guest to owner needs an explicit org binding, not a member-role edit.
		expect(
			memberChangeError(
				'owner',
				{ action: 'update-role', targetRole: 'guest', role: 'owner', self: false },
				2,
			),
		).toContain('org binding');
		expect(
			memberChangeError(
				'owner',
				{ action: 'update-role', targetRole: 'guest', role: 'viewer', self: false },
				2,
			),
		).toBeDefined();
		// Removing a guest follows the ordinary member rule: no owner special case.
		expect(
			memberChangeError('admin', { action: 'remove', targetRole: 'guest', self: false }, 1),
		).toBeUndefined();
	});
});

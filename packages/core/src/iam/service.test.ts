import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import type { Principal } from '@yoal/contracts';
import { ForbiddenError } from '../errors.ts';
import { createCore, type Core } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';
import { buildPrincipal } from '../orgs.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-iam-'));
const opened = createDb({ path: ':memory:' });
let now = Date.parse('2026-11-08T12:00:00Z');
let core: Core;

function open(): Core {
	return createCore({
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
			now: () => now,
		},
	});
}

function principal(
	overrides: Partial<Parameters<typeof buildPrincipal>[0]> & {
		restriction?: Principal['restriction'];
	} = {},
): Principal {
	const { restriction, ...input } = overrides;
	const built = buildPrincipal({
		kind: 'user',
		userId: 'user_1',
		orgId: 'org_1',
		role: 'owner',
		...input,
	});
	if (restriction) built.restriction = restriction;
	return built;
}

function addMember(userId: string, role: string): void {
	opened.sqlite.run(
		`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, 'org_1', ?, ?, ?)`,
		[`mem_${userId}`, userId, role, new Date(now).toISOString()],
	);
}

beforeEach(() => {
	now = Date.parse('2026-11-08T12:00:00Z');
	opened.sqlite.exec(`
		DELETE FROM iam_bindings;
		DELETE FROM iam_group_members;
		DELETE FROM iam_groups;
		DELETE FROM iam_roles;
		DELETE FROM iam_guardrails;
		DELETE FROM iam_state;
		CREATE TABLE IF NOT EXISTS member (id TEXT PRIMARY KEY, organizationId TEXT, userId TEXT, role TEXT, createdAt TEXT);
		DELETE FROM member;
	`);
	core = open();
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('roles', () => {
	test('built-in roles are seeded as read-only rows', () => {
		const roles = core.ctx.iam.listRoles('org_1');
		expect(roles.map((role) => role.name)).toEqual([
			'owner',
			'admin',
			'deployer',
			'viewer',
			'guest',
		]);
		expect(roles.every((role) => role.builtIn)).toBe(true);
	});

	test('a custom role is created from catalog permissions and cannot duplicate a built-in', () => {
		const owner = principal();
		const role = core.ctx.iam.createRole(owner, {
			name: 'release-manager',
			description: 'Can deploy',
			permissions: ['project:read', 'deployment:create'],
		});
		expect(role).toMatchObject({ name: 'release-manager', builtIn: false });
		expect(core.ctx.iam.listRoles('org_1').map((entry) => entry.name)).toContain('release-manager');
		expect(() =>
			core.ctx.iam.createRole(owner, { name: 'owner', permissions: ['project:read'] }),
		).toThrow(/already exists/);
		expect(() =>
			core.ctx.iam.createRole(owner, { name: 'bad', permissions: ['nope:thing'] }),
		).toThrow(/not a permission/);
	});

	test('deployers cannot manage roles', () => {
		addMember('user_d', 'deployer');
		const deployer = principal({ userId: 'user_d', role: 'deployer' });
		expect(() =>
			core.ctx.iam.createRole(deployer, { name: 'x-role', permissions: ['project:read'] }),
		).toThrow(ForbiddenError);
	});
});

describe('bindings and the decision', () => {
	test('a member without bindings gets an org binding from member.role', () => {
		addMember('user_1', 'deployer');
		const deployer = principal({ role: 'deployer' });
		expect(core.ctx.iam.can(deployer, 'project:create', { type: 'org' })).toBe(true);
		expect(core.ctx.iam.can(deployer, 'org:update', { type: 'org' })).toBe(false);
	});

	test('a custom role at project scope is limited to that project', () => {
		const owner = principal();
		const role = core.ctx.iam.createRole(owner, {
			name: 'project-reader',
			permissions: ['project:read', 'deployment:read'],
		});
		core.ctx.iam.bind(owner, {
			principalType: 'user',
			principalId: 'user_2',
			roleId: role.id,
			scope: { type: 'project', id: 'prj_1' },
		});
		const guest = principal({ userId: 'user_2', role: 'viewer' });
		expect(core.ctx.iam.can(guest, 'project:read', { type: 'project', id: 'prj_1' })).toBe(true);
		expect(core.ctx.iam.can(guest, 'project:read', { type: 'project', id: 'prj_2' })).toBe(false);
		expect(core.ctx.iam.can(guest, 'deployment:delete', { type: 'project', id: 'prj_1' })).toBe(false);
	});

	test('an expired binding stops allowing', () => {
		const owner = principal();
		core.ctx.iam.bind(owner, {
			principalType: 'user',
			principalId: 'user_2',
			roleId: 'viewer',
			scope: { type: 'org' },
			expiresAt: now + 60_000,
		});
		const viewer = principal({ userId: 'user_2', role: 'viewer' });
		expect(core.ctx.iam.can(viewer, 'project:read', { type: 'org' })).toBe(true);
		now += 60_001;
		expect(core.ctx.iam.can(viewer, 'project:read', { type: 'org' })).toBe(false);
		expect(core.ctx.iam.explain(viewer, 'project:read', { type: 'org' }).reason).toBe('expired');
	});

	test('a write bumps iamVersion and drops the cache', () => {
		const owner = principal();
		const binding = core.ctx.iam.bind(owner, {
			principalType: 'user',
			principalId: 'user_2',
			roleId: 'viewer',
			scope: { type: 'org' },
		});
		const viewer = principal({ userId: 'user_2', role: 'viewer' });
		expect(core.ctx.iam.can(viewer, 'project:read', { type: 'org' })).toBe(true);
		const before = core.ctx.iam.version('org_1');
		core.ctx.iam.unbind(owner, binding.id);
		expect(core.ctx.iam.version('org_1')).toBe(before + 1);
		expect(core.ctx.iam.can(viewer, 'project:read', { type: 'org' })).toBe(false);
	});

	test('a group binding grants its members access', () => {
		const owner = principal();
		addMember('user_2', 'viewer');
		const group = core.ctx.iam.createGroup(owner, { name: 'eng' });
		core.ctx.iam.addGroupMember(owner, group.id, 'user_2');
		core.ctx.iam.bind(owner, {
			principalType: 'group',
			principalId: group.id,
			roleId: 'deployer',
			scope: { type: 'project', id: 'prj_1' },
		});
		const member = principal({ userId: 'user_2', role: 'viewer' });
		expect(core.ctx.iam.can(member, 'deployment:create', { type: 'project', id: 'prj_1' })).toBe(true);
		core.ctx.iam.removeGroupMember(owner, group.id, 'user_2');
		expect(core.ctx.iam.can(member, 'deployment:create', { type: 'project', id: 'prj_1' })).toBe(false);
	});

	test('scopeFilter tells a list query what it may show', () => {
		addMember('user_1', 'owner');
		const owner = principal();
		core.ctx.iam.bind(owner, {
			principalType: 'user',
			principalId: 'user_2',
			roleId: 'viewer',
			scope: { type: 'project', id: 'prj_1' },
		});
		core.ctx.iam.bind(owner, {
			principalType: 'user',
			principalId: 'user_2',
			roleId: 'viewer',
			scope: { type: 'environment', projectId: 'prj_2', id: 'env_1' },
		});
		const guest = principal({ userId: 'user_2', role: 'viewer' });
		expect(core.ctx.iam.scopeFilter(guest, 'project:read')).toEqual(new Set(['prj_1', 'prj_2']));
		expect(core.ctx.iam.scopeFilter(principal(), 'project:read')).toBe('all');
	});

	test('a guest is allowed on its project and denied org-wide (IAM.md §8.2)', () => {
		addMember('user_1', 'owner');
		addMember('user_guest', 'guest');
		opened.sqlite.run(
			`INSERT OR REPLACE INTO projects
			   (id, org_id, slug, name, runtime, placement, created_by, created_at, updated_at)
			 VALUES ('prj_1', 'org_1', 'guest-project', 'Guest project', 'static', 'edge', 'user_1', ?, ?)`,
			[now, now],
		);
		const owner = principal();
		const bindingId = core.ctx.iam.grantGuestProject({
			orgId: 'org_1',
			userId: 'user_guest',
			projectId: 'prj_1',
			roleId: 'viewer',
			createdBy: 'user_1',
		});
		const guest = principal({ userId: 'user_guest', role: 'guest' });

		// The role itself carries nothing; the binding is the whole grant.
		expect(guest.permissions.size).toBe(0);
		expect(core.ctx.iam.can(guest, 'project:read', { type: 'project', id: 'prj_1' })).toBe(true);
		expect(core.ctx.iam.can(guest, 'deployment:read', { type: 'project', id: 'prj_1' })).toBe(true);
		// Org lists and projects they are not bound to are closed.
		expect(core.ctx.iam.can(guest, 'project:read', { type: 'org' })).toBe(false);
		expect(core.ctx.iam.can(guest, 'project:read', { type: 'project', id: 'prj_2' })).toBe(false);
		expect(core.ctx.iam.scopeFilter(guest, 'project:read')).toEqual(new Set(['prj_1']));
		// Member sync never turns `member.role = 'guest'` into an org binding.
		expect(
			opened.sqlite
				.query(
					"SELECT count(*) AS n FROM iam_bindings WHERE principal_id = 'user_guest' AND scope_type = 'org'",
				)
				.get(),
		).toEqual({ n: 0 });

		core.ctx.iam.updateProjectBindingRole(owner, bindingId, 'prj_1', 'deployer');
		expect(
			core.ctx.iam.can(guest, 'deployment:create', { type: 'project', id: 'prj_1' }),
		).toBe(true);

		// Removing the member (or their access) drops the project bindings.
		expect(core.ctx.iam.removeUserBindings('org_1', 'user_guest')).toBe(1);
		expect(core.ctx.iam.can(guest, 'project:read', { type: 'project', id: 'prj_1' })).toBe(false);
		opened.sqlite.run("DELETE FROM projects WHERE id = 'prj_1'");
	});

	test('an API key is capped by its grants even when its user is an owner', () => {
		const owner = principal();
		core.ctx.iam.bind(owner, {
			principalType: 'user',
			principalId: 'user_1',
			roleId: 'owner',
			scope: { type: 'org' },
		});
		const key = principal({
			kind: 'apiKey',
			role: 'owner',
			granted: ['project:read'],
			keyId: 'key_1',
		});
		expect(core.ctx.iam.can(key, 'project:read', { type: 'org' })).toBe(true);
		expect(core.ctx.iam.can(key, 'database:read', { type: 'org' })).toBe(false);
	});

	test('a token restriction narrows a service account for every kind and is part of the cache key', () => {
		const owner = principal();
		core.ctx.iam.bind(owner, {
			principalType: 'serviceAccount',
			principalId: 'sa_token',
			roleId: 'owner',
			scope: { type: 'org' },
		});
		const uncapped = principal({ kind: 'serviceAccount', userId: 'sa_token' });
		expect(core.ctx.iam.can(uncapped, 'database:read', { type: 'org' })).toBe(true);

		const restricted = principal({
			kind: 'serviceAccount',
			userId: 'sa_token',
			restriction: {
				permissions: ['project:read'],
				resources: ['project:prj_1'],
			},
		});
		expect(core.ctx.iam.can(restricted, 'project:read', { type: 'project', id: 'prj_1' })).toBe(true);
		expect(core.ctx.iam.can(restricted, 'project:read', { type: 'project', id: 'prj_2' })).toBe(false);
		expect(core.ctx.iam.can(restricted, 'database:read', { type: 'org' })).toBe(false);

		// A different resource list is a different compiled principal, not a cache hit.
		const elsewhere = principal({
			kind: 'serviceAccount',
			userId: 'sa_token',
			restriction: {
				permissions: ['project:read'],
				resources: ['project:prj_2'],
			},
		});
		expect(core.ctx.iam.can(elsewhere, 'project:read', { type: 'project', id: 'prj_2' })).toBe(true);
		expect(core.ctx.iam.can(elsewhere, 'project:read', { type: 'project', id: 'prj_1' })).toBe(false);
	});

	test('a guardrail beats an owner binding', () => {
		const owner = principal();
		core.ctx.iam.bind(owner, {
			principalType: 'user',
			principalId: 'user_1',
			roleId: 'owner',
			scope: { type: 'org' },
		});
		opened.sqlite.run(
			`INSERT INTO iam_guardrails
			   (id, org_id, name, permissions_json, enabled, created_by, created_at, updated_at)
			 VALUES ('g1', 'org_1', 'no secrets to robots', '["database:credentials"]', 1, 'system', ?, ?)`,
			[now, now],
		);
		const robot = principal({ kind: 'serviceAccount', userId: 'sa_1', role: 'owner' });
		// The service account has no binding of its own; bind the same role for it.
		core.ctx.iam.bind(owner, {
			principalType: 'serviceAccount',
			principalId: 'sa_1',
			roleId: 'owner',
			scope: { type: 'org' },
		});
		expect(core.ctx.iam.can(robot, 'project:read', { type: 'org' })).toBe(true);
		expect(core.ctx.iam.explain(robot, 'database:credentials', { type: 'org' })).toMatchObject({
			allow: false,
			reason: 'guardrail',
			via: 'g1',
		});
	});

	test('whoCan expands groups and the member base role', () => {
		addMember('user_1', 'owner');
		addMember('user_2', 'viewer');
		const owner = principal();
		const group = core.ctx.iam.createGroup(owner, { name: 'release' });
		core.ctx.iam.addGroupMember(owner, group.id, 'user_2');
		core.ctx.iam.bind(owner, {
			principalType: 'group',
			principalId: group.id,
			roleId: 'deployer',
			scope: { type: 'project', id: 'prj_1' },
		});
		expect(
			core.ctx.iam
				.whoCan('org_1', 'org:update', { type: 'org' })
				.map((entry) => entry.principalId),
		).toEqual(['user_1']);
		expect(
			core.ctx.iam
				.whoCan('org_1', 'deployment:create', { type: 'project', id: 'prj_1' })
				.map((entry) => entry.principalId)
				.sort(),
		).toEqual(['user_1', 'user_2']);
	});

	test('a named system principal uses its fixed permissions, not bindings', () => {
		const robot: Principal = {
			kind: 'system',
			userId: 'system:alerts',
			orgId: 'org_1',
			role: 'viewer',
			permissions: new Set(['project:read']),
			credential: 'system',
		};
		expect(core.ctx.iam.can(robot, 'project:read', { type: 'org' })).toBe(true);
		expect(core.ctx.iam.can(robot, 'project:delete', { type: 'org' })).toBe(false);
	});

	test('a principal with no binding rows keeps its legacy permissions during I2', () => {
		const legacy = principal({ userId: 'user_legacy', role: 'viewer' });
		expect(core.ctx.iam.can(legacy, 'project:read', { type: 'org' })).toBe(true);
		expect(core.ctx.iam.can(legacy, 'project:delete', { type: 'org' })).toBe(false);
	});

	test('a deny explains its chain and require throws', () => {
		addMember('user_1', 'viewer');
		const viewer = principal({ role: 'viewer' });
		const decision = core.ctx.iam.explain(viewer, 'project:delete', { type: 'org' });
		expect(decision).toMatchObject({ allow: false, reason: 'no-binding' });
		expect(() => core.ctx.iam.require(viewer, 'project:delete', { type: 'org' })).toThrow(
			ForbiddenError,
		);
	});
});

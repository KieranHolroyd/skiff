import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import type { Permission, Principal } from '@skiff/contracts';
import { ForbiddenError } from '../errors.ts';
import { createCore, type Core } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';
import { buildPrincipal } from '../orgs.ts';

/**
 * Draft simulations (IAM.md §9.3, I12) and the guest MCP decision (IAM.md §8.2). A guest's access
 * comes from project bindings, not the empty `guest` role; an MCP token must not cap that away.
 */

const dir = mkdtempSync(join(tmpdir(), 'skiff-iam-simulate-'));
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

describe('simulate', () => {
	test('a binding draft reports the grants at its scope and saves nothing', () => {
		addMember('user_1', 'owner');
		const owner = principal();
		// Compile once so the lazy member -> binding sync happens before the dry run.
		core.ctx.iam.compiledFor(owner);
		const beforeVersion = core.ctx.iam.version('org_1');
		const bindingsBefore = core.ctx.iam.listBindings('org_1');

		const result = core.ctx.iam.simulate(owner, {
			sample: { principalType: 'user', principalId: 'user_guest' },
			change: { kind: 'binding', roleId: 'viewer', scope: { type: 'project', id: 'prj_1' } },
		});

		expect(result.applied).toBe(false);
		expect(result.sample).toEqual({ principalType: 'user', principalId: 'user_guest' });
		expect(result.added).toEqual(expect.arrayContaining(['project:read', 'deployment:read']));
		expect(result.removed).toEqual([]);
		expect(result.changes).toContainEqual(
			expect.objectContaining({
				permission: 'project:read',
				resource: { type: 'project', id: 'prj_1' },
				before: false,
				after: true,
				change: 'granted',
			}),
		);
		// A dry run never moves the version or writes a row.
		expect(core.ctx.iam.version('org_1')).toBe(beforeVersion);
		expect(core.ctx.iam.listBindings('org_1')).toEqual(bindingsBefore);
	});

	test('a role edit reports removals and leaves the role and bindings alone', () => {
		addMember('user_1', 'owner');
		const owner = principal();
		const role = core.ctx.iam.createRole(owner, {
			name: 'reader',
			permissions: ['project:read', 'deployment:read'],
		});
		core.ctx.iam.bind(owner, {
			principalType: 'user',
			principalId: 'user_guest',
			roleId: role.id,
			scope: { type: 'project', id: 'prj_1' },
		});

		const result = core.ctx.iam.simulate(owner, {
			sample: { principalType: 'user', principalId: 'user_guest' },
			change: { kind: 'role', roleId: role.id, permissions: ['project:read'] },
		});

		expect(result.applied).toBe(false);
		expect(result.added).toEqual([]);
		expect(result.removed).toEqual(['deployment:read']);
		expect(result.changes).toEqual([
			expect.objectContaining({
				permission: 'deployment:read',
				resource: { type: 'project', id: 'prj_1' },
				before: true,
				after: false,
				change: 'revoked',
			}),
		]);
		expect(core.ctx.iam.listRoles('org_1').find((entry) => entry.id === role.id)?.permissions).toEqual([
			'project:read',
			'deployment:read',
		]);
		expect(core.ctx.iam.can(principal({ userId: 'user_guest', role: 'guest' }), 'deployment:read', {
			type: 'project',
			id: 'prj_1',
		})).toBe(true);
	});

	test('validates the role, scope, expiry and permission catalog before reporting a diff', () => {
		addMember('user_1', 'owner');
		const owner = principal();
		const role = core.ctx.iam.createRole(owner, { name: 'reader', permissions: ['project:read'] });
		const sample = { principalType: 'user' as const, principalId: 'user_2' };

		expect(() =>
			core.ctx.iam.simulate(owner, {
				sample,
				change: { kind: 'binding', roleId: 'missing', scope: { type: 'org' } },
			}),
		).toThrow(/Unknown role/);
		expect(() =>
			core.ctx.iam.simulate(owner, {
				sample,
				change: { kind: 'binding', roleId: 'viewer', scope: { type: 'platform' } },
			}),
		).toThrow(/platform/);
		expect(() =>
			core.ctx.iam.simulate(owner, {
				sample,
				change: {
					kind: 'binding',
					roleId: 'viewer',
					scope: { type: 'org' },
					expiresAt: now - 1,
				},
			}),
		).toThrow(/expiry/);
		expect(() =>
			core.ctx.iam.simulate(owner, {
				sample,
				change: { kind: 'role', roleId: 'viewer', permissions: ['project:read'] },
			}),
		).toThrow(/Built-in/);
		expect(() =>
			core.ctx.iam.simulate(owner, {
				sample,
				change: { kind: 'role', roleId: role.id, permissions: ['project:teleport'] },
			}),
		).toThrow(/not a permission/);
	});

	test('a caller without iam:read cannot simulate', () => {
		addMember('user_v', 'viewer');
		const viewer = principal({ userId: 'user_v', role: 'viewer' });
		expect(() =>
			core.ctx.iam.simulate(viewer, {
				sample: { principalType: 'user', principalId: 'user_v' },
				change: { kind: 'binding', roleId: 'viewer', scope: { type: 'org' } },
			}),
		).toThrow(ForbiddenError);
	});
});

describe('guest MCP decisions', () => {
	test('a guest MCP token is decided by its project binding, not the empty guest role', () => {
		addMember('user_1', 'owner');
		addMember('user_guest', 'guest');
		const owner = principal();
		core.ctx.iam.bind(owner, {
			principalType: 'user',
			principalId: 'user_guest',
			roleId: 'viewer',
			scope: { type: 'project', id: 'prj_1' },
		});

		const guestMcp: Principal = {
			...principal({ userId: 'user_guest', role: 'guest' }),
			kind: 'mcp',
			credential: 'oauth',
			permissions: new Set<Permission>(),
		};
		expect(guestMcp.permissions.size).toBe(0);

		expect(core.ctx.iam.can(guestMcp, 'project:read', { type: 'project', id: 'prj_1' })).toBe(true);
		expect(core.ctx.iam.can(guestMcp, 'deployment:read', { type: 'project', id: 'prj_1' })).toBe(true);
		expect(core.ctx.iam.can(guestMcp, 'project:read', { type: 'project', id: 'prj_2' })).toBe(false);
		expect(core.ctx.iam.can(guestMcp, 'project:read', { type: 'org' })).toBe(false);
		expect(core.ctx.iam.scopeFilter(guestMcp, 'project:read')).toEqual(new Set(['prj_1']));
	});

	test('a non-guest MCP token is still capped by its consent scopes', () => {
		addMember('user_1', 'owner');
		addMember('user_2', 'viewer');
		const owner = principal();
		core.ctx.iam.bind(owner, {
			principalType: 'user',
			principalId: 'user_2',
			roleId: 'deployer',
			scope: { type: 'project', id: 'prj_1' },
		});

		const token: Principal = {
			...principal({ userId: 'user_2', role: 'viewer' }),
			kind: 'mcp',
			credential: 'oauth',
			permissions: new Set<Permission>(['project:read']),
		};
		expect(core.ctx.iam.can(token, 'project:read', { type: 'project', id: 'prj_1' })).toBe(true);
		expect(core.ctx.iam.can(token, 'deployment:create', { type: 'project', id: 'prj_1' })).toBe(false);
	});
});

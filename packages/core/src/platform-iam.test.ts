import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import type { Principal } from '@yoal/contracts';
import { createCore, type Core } from './index.ts';
import { NotFoundError } from './errors.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-platform-iam-'));
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

type PrincipalOptions = Partial<Parameters<typeof buildPrincipal>[0]> & {
	credential?: Principal['credential'];
};

function principal(overrides: PrincipalOptions = {}): Principal {
	const { credential, ...rest } = overrides;
	const built = buildPrincipal({
		kind: 'user',
		userId: 'user_admin',
		orgId: 'org_1',
		role: 'owner',
		platformAdmin: true,
		...rest,
	});
	return credential ? { ...built, credential } : built;
}

function addUser(userId: string, role: string): void {
	opened.sqlite.run('INSERT INTO user (id, role) VALUES (?, ?)', [userId, role]);
}

function platformRows(): Array<{
	id: string;
	role_id: string;
	condition_json: string | null;
	created_by: string;
}> {
	return opened.sqlite
		.query<{ id: string; role_id: string; condition_json: string | null; created_by: string }, []>(
			`SELECT id, role_id, condition_json, created_by FROM iam_bindings
			 WHERE org_id IS NULL AND scope_type = 'platform' ORDER BY created_at`,
		)
		.all();
}

beforeEach(() => {
	now = Date.parse('2026-11-08T12:00:00Z');
	opened.sqlite.exec(`
		CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, role TEXT);
		DELETE FROM iam_bindings;
		DELETE FROM iam_group_members;
		DELETE FROM iam_groups;
		DELETE FROM iam_roles;
		DELETE FROM iam_guardrails;
		DELETE FROM iam_state;
		DELETE FROM user;
	`);
	core = open();
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('platform admin seeding', () => {
	test('the Better Auth admin flag seeds one session-only platform-admin binding', () => {
		addUser('user_admin', 'admin');

		expect(core.ctx.platformIam.sync('user_admin')).toEqual({ admin: true, changed: true });
		const rows = platformRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			role_id: 'platform-admin',
			created_by: 'system:platform-sync',
		});
		expect(JSON.parse(rows[0]!.condition_json!)).toEqual({
			op: 'credentialIn',
			credentials: ['session'],
		});

		// Syncing again is idempotent.
		expect(core.ctx.platformIam.sync('user_admin')).toEqual({ admin: true, changed: false });
		expect(platformRows()).toHaveLength(1);
	});

	test('losing the admin flag removes only the seeded binding', () => {
		addUser('user_admin', 'admin');
		const admin = principal();
		core.ctx.platformIam.sync('user_admin');

		// A manually granted platform role is not the sync's to remove.
		opened.sqlite.run(
			`INSERT INTO iam_bindings
			   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, scope_parent_id,
			    condition_json, expires_at, reason, created_by, created_at)
			 VALUES ('bind_manual', NULL, 'user', 'user_admin', 'platform-viewer', 'platform', NULL, NULL,
			         NULL, NULL, NULL, ?, ?)`,
			[admin.userId, now],
		);

		opened.sqlite.run("UPDATE user SET role = 'user' WHERE id = 'user_admin'");
		expect(core.ctx.platformIam.sync('user_admin')).toEqual({ admin: false, changed: true });
		expect(platformRows().map((row) => row.role_id)).toEqual(['platform-viewer']);
	});

	test('a user with no Better Auth row still loses a stale seeded binding', () => {
		addUser('user_admin', 'admin');
		core.ctx.platformIam.sync('user_admin');
		opened.sqlite.run("DELETE FROM user WHERE id = 'user_admin'");
		expect(core.ctx.platformIam.sync('user_admin')).toEqual({ admin: false, changed: true });
		expect(platformRows()).toHaveLength(0);
	});
});

describe('platform roles', () => {
	test('operator can run the fleet but cannot change settings, domains or quotas', () => {
		const admin = principal({ credential: 'session' });
		core.ctx.platformIam.bind(admin, { userId: 'user_op', roleId: 'platform-operator' });
		const operator = principal({
			userId: 'user_op',
			role: 'viewer',
			platformAdmin: false,
		});

		expect(core.ctx.platformIam.can(operator, 'platform:read')).toBe(true);
		expect(core.ctx.platformIam.can(operator, 'platform:nodes')).toBe(true);
		expect(core.ctx.platformIam.can(operator, 'platform:drain')).toBe(true);
		expect(core.ctx.platformIam.can(operator, 'platform:storage')).toBe(true);
		expect(core.ctx.platformIam.can(operator, 'platform:ha')).toBe(true);
		expect(core.ctx.platformIam.can(operator, 'platform:updates')).toBe(true);
		expect(core.ctx.platformIam.can(operator, 'platform:settings')).toBe(false);
		expect(core.ctx.platformIam.can(operator, 'platform:domains')).toBe(false);
		expect(core.ctx.platformIam.can(operator, 'platform:quotas')).toBe(false);
		expect(core.ctx.platformIam.can(operator, 'platform:maintenance')).toBe(false);
	});

	test('viewer gets fleet reads only', () => {
		const admin = principal({ credential: 'session' });
		core.ctx.platformIam.bind(admin, { userId: 'user_view', roleId: 'platform-viewer' });
		const viewer = principal({ userId: 'user_view', role: 'viewer', platformAdmin: false });

		expect(core.ctx.platformIam.canView(viewer)).toBe(true);
		expect(core.ctx.platformIam.can(viewer, 'platform:read')).toBe(true);
		expect(core.ctx.platformIam.can(viewer, 'platform:nodes')).toBe(false);
		expect(core.ctx.platformIam.canAdminister(viewer)).toBe(false);
	});

	test('a platform binding never confers an org permission', () => {
		const admin = principal({ credential: 'session' });
		core.ctx.platformIam.bind(admin, { userId: 'user_op', roleId: 'platform-operator' });
		const operator = principal({ userId: 'user_op', role: 'viewer', platformAdmin: false });

		// `can` only exposes the platform permissions; there is no org fallback in the engine.
		expect(core.ctx.platformIam.can(operator, 'project:read')).toBe(false);
		expect(core.ctx.platformIam.can(operator, 'iam:manage-owners')).toBe(false);
	});

	test('a group binding applies to every current member', () => {
		const admin = principal({ credential: 'session' });
		opened.sqlite.run(
			`INSERT INTO iam_groups (id, org_id, name, created_at, updated_at)
			 VALUES ('grp_ops', 'org_1', 'Ops', ?, ?)`,
			[now, now],
		);
		for (const userId of ['user_op', 'user_oncall'])
			opened.sqlite.run(
				`INSERT INTO iam_group_members (group_id, user_id, created_at) VALUES ('grp_ops', ?, ?)`,
				[userId, now],
			);

		const bound = core.ctx.platformIam.bind(admin, {
			groupId: 'grp_ops',
			roleId: 'platform-operator',
		});
		expect(bound).toMatchObject({
			principalType: 'group',
			principalId: 'grp_ops',
			roleId: 'platform-operator',
		});
		expect(core.ctx.platformIam.list(admin)).toHaveLength(1);

		for (const userId of ['user_op', 'user_oncall']) {
			const member = principal({ userId, role: 'viewer', platformAdmin: false });
			expect(core.ctx.platformIam.can(member, 'platform:nodes')).toBe(true);
			expect(core.ctx.platformIam.can(member, 'platform:storage')).toBe(true);
			expect(core.ctx.platformIam.can(member, 'platform:ha')).toBe(true);
			expect(core.ctx.platformIam.can(member, 'platform:settings')).toBe(false);
		}

		// Someone outside the group gets nothing.
		const outsider = principal({ userId: 'user_out', role: 'viewer', platformAdmin: false });
		expect(core.ctx.platformIam.canView(outsider)).toBe(false);

		// Removing the membership takes effect on the next check.
		opened.sqlite.run(
			`DELETE FROM iam_group_members WHERE group_id = 'grp_ops' AND user_id = 'user_op'`,
		);
		const former = principal({ userId: 'user_op', role: 'viewer', platformAdmin: false });
		expect(core.ctx.platformIam.canView(former)).toBe(false);
	});

	test('a group binding needs a real group and cannot also name a user', () => {
		const admin = principal({ credential: 'session' });
		expect(() =>
			core.ctx.platformIam.bind(admin, { groupId: 'grp_missing', roleId: 'platform-viewer' }),
		).toThrow(/no group/);
		expect(() =>
			core.ctx.platformIam.bind(admin, {
				userId: 'user_view',
				groupId: 'grp_ops',
				roleId: 'platform-viewer',
			}),
		).toThrow(/exactly one user id or group id/);
	});
});

describe('D129 session-only condition', () => {
	test('a seeded platform-admin binding works from a session and denies an API key', () => {
		addUser('user_admin', 'admin');
		core.ctx.platformIam.sync('user_admin');

		const session = principal({ credential: 'session' });
		expect(core.ctx.platformIam.can(session, 'platform:nodes')).toBe(true);
		expect(core.ctx.platformIam.canAdminister(session)).toBe(true);

		const apiKey = principal({ kind: 'apiKey', credential: 'apiKey' });
		expect(core.ctx.platformIam.can(apiKey, 'platform:nodes')).toBe(false);
		expect(core.ctx.platformIam.can(apiKey, 'platform:read')).toBe(false);
		expect(core.ctx.platformIam.canAdminister(apiKey)).toBe(false);
	});

	test('a platform-admin binding without the condition is the quota-write exception', () => {
		addUser('user_admin', 'admin');
		core.ctx.platformIam.sync('user_admin');
		const session = principal({ credential: 'session' });
		const apiKey = principal({ kind: 'apiKey', credential: 'apiKey' });

		const [seeded] = core.ctx.platformIam.platformBindings();
		core.ctx.platformIam.unbind(session, seeded!.id);
		core.ctx.platformIam.bind(session, {
			userId: 'user_admin',
			roleId: 'platform-admin',
			condition: null,
		});

		expect(core.ctx.platformIam.can(apiKey, 'platform:quotas')).toBe(true);
		expect(core.ctx.platformIam.can(apiKey, 'platform:settings')).toBe(true);
	});
});

describe('writes', () => {
	test('a non-admin cannot bind or unbind', () => {
		const viewer = principal({ role: 'viewer', platformAdmin: false });

		expect(() =>
			core.ctx.platformIam.bind(viewer, { userId: 'user_view', roleId: 'platform-viewer' }),
		).toThrow(/platform:admin/);
		expect(() => core.ctx.platformIam.unbind(viewer, 'bind_missing')).toThrow(/platform:admin/);
		expect(platformRows()).toHaveLength(0);
	});

	test('an operator cannot grant platform roles', () => {
		const admin = principal({ credential: 'session' });
		core.ctx.platformIam.bind(admin, { userId: 'user_op', roleId: 'platform-operator' });
		const operator = principal({ userId: 'user_op', role: 'viewer', platformAdmin: false });

		expect(() =>
			core.ctx.platformIam.bind(operator, { userId: 'user_view', roleId: 'platform-viewer' }),
		).toThrow(/platform:admin/);
	});

	test('bind is idempotent and rejects unknown roles', () => {
		const admin = principal({ credential: 'session' });
		const first = core.ctx.platformIam.bind(admin, {
			userId: 'user_view',
			roleId: 'platform-viewer',
		});
		const second = core.ctx.platformIam.bind(admin, {
			userId: 'user_view',
			roleId: 'platform-viewer',
		});
		expect(second.id).toBe(first.id);
		expect(platformRows()).toHaveLength(1);
		expect(() =>
			core.ctx.platformIam.bind(admin, { userId: 'user_view', roleId: 'owner' }),
		).toThrow(/not a platform( admin)? role/);
	});
});

/** Run a service method that is expected to pass authorization; a 403 is a failure. */
function notForbidden(run: () => unknown): void {
	try {
		run();
	} catch (error) {
		expect((error as { status?: number }).status).not.toBe(403);
	}
}

/** A denial, whether the module throws `ForbiddenError` or its own `CoreError('forbidden', …, 403)`. */
function expectForbidden(run: () => unknown): void {
	let caught: unknown;
	try {
		run();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeDefined();
	expect((caught as { status?: number }).status).toBe(403);
}

function asOperator(): Principal {
	return principal({ userId: 'user_op', role: 'viewer', platformAdmin: false });
}

function asViewer(): Principal {
	return principal({ userId: 'user_view', role: 'viewer', platformAdmin: false });
}

function bindRole(userId: string, roleId: 'platform-operator' | 'platform-viewer'): void {
	core.ctx.platformIam.bind(principal({ credential: 'session' }), { userId, roleId });
}

describe('platform services behind ctx.platformIam', () => {
	test('operator reads the fleet and reaches node, drain and storage paths', () => {
		bindRole('user_op', 'platform-operator');
		const operator = asOperator();

		notForbidden(() => core.nodes.list(operator));
		notForbidden(() => core.disks.overview(operator));
		notForbidden(() => core.shares.list(operator));
		notForbidden(() => core.topology.view(operator));
		notForbidden(() => core.workloads.capacity(operator));
		notForbidden(() => core.ingress.status(operator));
		notForbidden(() => core.failover.status(operator));
		notForbidden(() => core.failover.history(operator));

		// Drain passes authorization and fails only because there is no such node.
		expect(() => core.nodes.setDraining(operator, 'node_missing', true)).toThrow(NotFoundError);
		// Storage writes pass authorization and are stopped later by input validation.
		notForbidden(() => core.disks.add(operator, {} as never));
	});

	test('operator cannot change settings, policies, cluster config or quotas', () => {
		bindRole('user_op', 'platform-operator');
		const operator = asOperator();

		expectForbidden(() => core.cluster.update(operator, {} as never));
		expectForbidden(() => core.policies.update(operator, {} as never));
		expectForbidden(() => core.registry.update(operator, {} as never));
		expectForbidden(() => core.metricsExport.updateSettings(operator, {} as never));
		expect(() => core.ctx.platformIam.bind(operator, { userId: 'user_x', roleId: 'platform-viewer' })).toThrow(
			/platform:admin/,
		);
	});

	test('viewer reads the fleet but every write path refuses it', () => {
		bindRole('user_view', 'platform-viewer');
		const viewer = asViewer();

		notForbidden(() => core.nodes.list(viewer));
		notForbidden(() => core.disks.overview(viewer));
		notForbidden(() => core.shares.list(viewer));
		notForbidden(() => core.topology.view(viewer));
		notForbidden(() => core.workloads.capacity(viewer));
		notForbidden(() => core.ingress.status(viewer));
		notForbidden(() => core.failover.status(viewer));
		notForbidden(() => core.failover.history(viewer));

		expectForbidden(() => core.nodes.setDraining(viewer, 'node_missing', true));
		expectForbidden(() => core.disks.add(viewer, {} as never));
		expectForbidden(() => core.shares.create(viewer, {} as never));
	});

	test('a plain member is refused every platform write and cannot see platform bindings', () => {
		const member = principal({ role: 'viewer', platformAdmin: false });

		expectForbidden(() => core.nodes.list(member));
		expectForbidden(() => core.workloads.capacity(member));
		expectForbidden(() => core.cluster.update(member, {} as never));
		expectForbidden(() => core.policies.update(member, {} as never));
		expectForbidden(() => core.ctx.platformIam.list(member));
	});

	test('D129: a seeded platform admin cannot use an API key for platform powers', () => {
		addUser('user_admin', 'admin');
		core.ctx.platformIam.sync('user_admin');
		const apiKey = principal({ kind: 'apiKey', credential: 'apiKey' });

		expectForbidden(() => core.nodes.list(apiKey));
		expectForbidden(() => core.workloads.capacity(apiKey));
		expectForbidden(() => core.cluster.update(apiKey, {} as never));
		expect(() => core.ctx.platformIam.bind(apiKey, { userId: 'user_x', roleId: 'platform-viewer' })).toThrow(
			/platform:admin/,
		);
	});
});

describe('platform binding API helpers', () => {
	test('list returns role metadata and only for a fleet read', () => {
		bindRole('user_view', 'platform-viewer');
		const admin = principal({ credential: 'session' });
		const listed = core.ctx.platformIam.list(admin);

		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			principalId: 'user_view',
			roleId: 'platform-viewer',
			roleName: 'platform-viewer',
			scope: { type: 'platform' },
		});
		expect(listed[0]!.roleDescription).toContain('Read-only');
	});

	test('bind validates the role and the expiry', () => {
		const admin = principal({ credential: 'session' });

		expect(() => core.ctx.platformIam.bind(admin, { userId: '', roleId: 'platform-viewer' })).toThrow(
			/user id/,
		);
		expect(() => core.ctx.platformIam.bind(admin, { userId: 'user_x', roleId: 'owner' })).toThrow(
			/not a platform( admin)? role/,
		);
		expect(() =>
			core.ctx.platformIam.bind(admin, {
				userId: 'user_x',
				roleId: 'platform-viewer',
				expiresAt: now - 1,
			}),
		).toThrow(/future/);
	});

	test('binding, listing and unbinding one user is idempotent', () => {
		const admin = principal({ credential: 'session' });
		const first = core.ctx.platformIam.bind(admin, { userId: 'user_view', roleId: 'platform-viewer' });
		expect(core.ctx.platformIam.list(admin)).toHaveLength(1);

		core.ctx.platformIam.unbind(admin, first.id);
		expect(core.ctx.platformIam.list(admin)).toHaveLength(0);
		expect(() => core.ctx.platformIam.unbind(admin, first.id)).toThrow(/Platform binding/);
	});

	test('a non-admin cannot use the binding helpers', () => {
		const member = principal({ role: 'viewer', platformAdmin: false });
		expectForbidden(() => core.ctx.platformIam.list(member));
		expect(() =>
			core.ctx.platformIam.bind(member, { userId: 'user_x', roleId: 'platform-viewer' }),
		).toThrow(/platform:admin/);
		expect(() => core.ctx.platformIam.unbind(member, 'bind_missing')).toThrow(/platform:admin/);
	});
});

describe('platform guardrails', () => {
	test('a fleet-wide guardrail beats an org allow and is visible to every org', () => {
		const admin = principal({ credential: 'session' });
		// Seed built-in roles and give the acting owner a real org binding, so the allow the
		// guardrail must beat comes from the engine rather than the legacy-role compatibility path.
		core.iam.listRoles('org_1');
		core.iam.bind(admin, {
			principalType: 'user',
			principalId: 'user_admin',
			roleId: 'owner',
			scope: { type: 'org' },
		});
		expect(core.iam.can(admin, 'project:delete', { type: 'org' })).toBe(true);

		const created = core.ctx.platformIam.createGuardrail(admin, {
			name: 'No project deletes',
			permissions: ['project:delete'],
		});

		expect(created).toMatchObject({ orgId: null, enabled: true, scope: null });
		expect(core.ctx.platformIam.listGuardrails(admin).map((row) => row.id)).toContain(created.id);

		// The engine loads `org_id IS NULL` rows for the org, and a guardrail wins over its allow.
		expect(core.ctx.iam.can(admin, 'project:delete', { type: 'org' })).toBe(false);
		expect(core.ctx.iam.can(admin, 'project:read', { type: 'org' })).toBe(true);

		core.ctx.platformIam.deleteGuardrail(admin, created.id);
		expect(core.ctx.iam.can(admin, 'project:delete', { type: 'org' })).toBe(true);
		expect(core.ctx.platformIam.listGuardrails(admin)).toHaveLength(0);
	});

	test('create, update and delete are platform-admin and iam:manage-guardrails gated', () => {
		const member = principal({ role: 'viewer', platformAdmin: false });
		expect(() =>
			core.ctx.platformIam.createGuardrail(member, { name: 'No reads', permissions: ['project:read'] }),
		).toThrow(/platform:admin/);

		// A platform admin whose own org role cannot manage guardrails is refused too.
		const viewerAdmin = principal({
			userId: 'user_view_admin',
			role: 'viewer',
			platformAdmin: true,
		});
		expect(() =>
			core.ctx.platformIam.createGuardrail(viewerAdmin, {
				name: 'No reads',
				permissions: ['project:read'],
			}),
		).toThrow(/iam:manage-guardrails/);
	});

	test('rejects an environment scope and empty permission lists', () => {
		const admin = principal({ credential: 'session' });
		expect(() =>
			core.ctx.platformIam.createGuardrail(admin, {
				name: 'Env only',
				permissions: ['project:read'],
				scope: { type: 'environment', id: 'env_1', projectId: 'proj_1' },
			}),
		).toThrow(/fleet-wide/);
		expect(() =>
			core.ctx.platformIam.createGuardrail(admin, { name: 'Nothing', permissions: [] }),
		).toThrow(/at least one permission/);
	});
});

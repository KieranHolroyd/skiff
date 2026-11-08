import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import type { Principal } from '@skiff/contracts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-platform-iam-'));
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
		).toThrow(/not a platform role/);
	});
});

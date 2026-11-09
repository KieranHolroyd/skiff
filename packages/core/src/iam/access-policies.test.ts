import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { evaluateAccessPolicy, type AccessPolicyRule } from '@yoal/contracts';
import { buildPrincipal } from '../orgs.ts';
import { createCore, type Core } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';

/**
 * CRUD for Yoal Access policies (IAM.md I25). The migration file owns the tables; this test creates
 * the same shape directly because `packages/db/src/migrations.ts` is regenerated separately and
 * these columns are not in the checked-in snapshot yet.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-access-policies-'));
const opened = createDb({ path: ':memory:' });
const clock = Date.parse('2026-11-08T12:00:00Z');

function ensureTables(): void {
	const additive = [
		'ALTER TABLE projects ADD COLUMN production_access_policy_id TEXT',
		'ALTER TABLE projects ADD COLUMN preview_access_policy_id TEXT',
		'ALTER TABLE environments ADD COLUMN access_policy_id TEXT',
		'ALTER TABLE access_policies ADD COLUMN version INTEGER NOT NULL DEFAULT 0',
	];
	for (const statement of additive) {
		try {
			opened.sqlite.exec(statement);
		} catch {
			// Already present once migrations.ts includes 0091.
		}
	}
	opened.sqlite.exec(`
		CREATE TABLE IF NOT EXISTS access_policies (
			id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '', scope_type TEXT NOT NULL, scope_id TEXT,
			scope_parent_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL,
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS access_policy_rules (
			policy_id TEXT NOT NULL, idx INTEGER NOT NULL, action TEXT NOT NULL CHECK (action IN ('allow','deny')),
			matcher_json TEXT NOT NULL, PRIMARY KEY (policy_id, idx)
		);
		CREATE TABLE IF NOT EXISTS access_service_tokens (
			id TEXT PRIMARY KEY, org_id TEXT NOT NULL, policy_id TEXT NOT NULL, name TEXT NOT NULL,
			header TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL,
			created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
		);
	`);
	try {
		opened.sqlite.exec('ALTER TABLE access_policies ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
	} catch {
		// Already present once migrations.ts includes 0104.
	}
}

ensureTables();

const core: Core = createCore({
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
		now: () => clock,
	},
});

const admin = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });

beforeEach(() => {
	opened.sqlite.exec(`
		DELETE FROM access_service_tokens;
		DELETE FROM access_policy_rules;
		DELETE FROM access_policies;
		DELETE FROM projects;
		DELETE FROM environments;
	`);
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const rules: AccessPolicyRule[] = [
	{ idx: 0, action: 'allow', matcher: { type: 'emailDomain', domain: 'example.com' } },
	{ idx: 1, action: 'deny', matcher: { type: 'email', email: 'blocked@example.com' } },
];

function project() {
	return core.projects.create(admin, {		name: 'Staging site',
		slug: 'staging-site',
		runtime: 'static',
		placement: 'edge',
		productionAccess: 'platform',
		previewAccess: 'platform',
	} as Parameters<typeof core.projects.create>[1]);
}

describe('access policy CRUD', () => {
	test('creates, lists, updates and removes an org policy', () => {
		const created = core.accessPolicies.create(admin, {
			name: 'Engineering',
			scope: { type: 'org' },
			rules,
		});
		expect(created.rules).toHaveLength(2);
		expect(created.scope).toEqual({ type: 'org' });
		expect(core.accessPolicies.list(admin).map((policy) => policy.name)).toEqual(['Engineering']);

		const updated = core.accessPolicies.update(admin, created.id, {
			name: 'Engineering staging',
			rules: [{ idx: 0, action: 'allow', matcher: { type: 'anyMember' } }],
		});
		expect(updated.name).toBe('Engineering staging');
		expect(updated.rules).toHaveLength(1);

		core.accessPolicies.remove(admin, created.id);
		expect(core.accessPolicies.list(admin)).toEqual([]);
	});

	test('a viewer cannot create or read policies', () => {
		expect(() =>
			core.accessPolicies.create(viewer, { name: 'Nope', scope: { type: 'org' }, rules: [] }),
		).toThrow(/accessPolicy:create/);
		expect(core.accessPolicies.list(viewer)).toEqual([]);
	});

	test('assigns a policy to a project and refuses to delete it while assigned', async () => {
		const createdProject = await project();
		const row = core.projects.requireRow(admin, createdProject.slug);
		const policy = core.accessPolicies.create(admin, {
			name: 'Engineering',
			scope: { type: 'org' },
			rules,
		});
		core.accessPolicies.assign(admin, row, { scope: 'production', policyId: policy.id });
		const view = await core.projects.get(admin, row.slug);
		expect(view.productionAccess).toBe('access');
		expect(view.productionAccessPolicyId).toBe(policy.id);

		expect(() => core.accessPolicies.remove(admin, policy.id)).toThrow(/Turn Yoal Access off/);
		core.accessPolicies.assign(admin, row, { scope: 'production', policyId: null });
		expect((await core.projects.get(admin, row.slug)).productionAccess).toBe('platform');
		core.accessPolicies.remove(admin, policy.id);
	});

	test('a pool session identity matches its pool and groups', () => {
		const poolRules: AccessPolicyRule[] = [
			{
				idx: 0,
				action: 'allow',
				matcher: { type: 'userPool', poolId: 'pool_1', groups: ['staff', 'admins'] },
			},
		];
		const decision = evaluateAccessPolicy(
			{ enabled: true, rules: poolRules },
			{ userPoolId: 'pool_1', poolGroups: ['staff'], email: 'ada@example.com' },
		);
		expect(decision).toBe('allow');
		expect(
			evaluateAccessPolicy(
				{ enabled: true, rules: poolRules },
				{ userPoolId: 'pool_2', poolGroups: ['staff'], email: 'ada@example.com' },
			),
		).toBe('deny');
	});

	test('removing a service token bumps only that policy, so other policies keep cookies', async () => {
		const createdProject = await project();
		const row = core.projects.requireRow(admin, createdProject.slug);
		const poolAndToken: AccessPolicyRule[] = [
			{ idx: 0, action: 'allow', matcher: { type: 'anyMember' } },
			{
				idx: 1,
				action: 'allow',
				matcher: {
					type: 'serviceToken',
					header: 'x-yoal-access-token',
					tokenHash: 'a'.repeat(64),
				},
			},
		];
		const policy = core.accessPolicies.create(admin, {
			name: 'Revocation',
			scope: { type: 'org' },
			rules: poolAndToken,
		});
		const other = core.accessPolicies.create(admin, {
			name: 'Other scope',
			scope: { type: 'org' },
			rules: [{ idx: 0, action: 'allow', matcher: { type: 'anyMember' } }],
		});
		core.accessPolicies.assign(admin, row, { scope: 'production', policyId: policy.id });
		core.accessPolicies.assign(admin, row, { scope: 'previews', policyId: other.id });
		const assigned = core.projects.requireRow(admin, createdProject.slug).siteSessionEpoch ?? 0;
		const siteKey = core.access.siteKeyFor({ id: createdProject.id }, policy.id);
		const otherKey = core.access.siteKeyFor({ id: createdProject.id }, other.id);
		const version = core.accessPolicies.get(admin, policy.id).version;
		expect(core.accessPolicies.edgeSettings(policy.id).serviceTokens).toHaveLength(1);

		// Adding a rule is not a revocation and must not sign existing visitors out.
		core.accessPolicies.update(admin, policy.id, {
			rules: [...poolAndToken, { idx: 2, action: 'deny', matcher: { type: 'email', email: 'x@example.com' } }],
		});
		expect(core.projects.requireRow(admin, createdProject.slug).siteSessionEpoch).toBe(assigned);
		expect(core.accessPolicies.get(admin, policy.id).version).toBe(version);

		// Revoking the service token bumps this policy's version only. Its cookies fail; the other
		// policy on the same project keeps exactly the key its visitors were signed with.
		core.accessPolicies.update(admin, policy.id, { rules: poolAndToken.slice(0, 1) });
		expect(core.projects.requireRow(admin, createdProject.slug).siteSessionEpoch).toBe(assigned);
		expect(core.accessPolicies.get(admin, policy.id).version).toBe(version + 1);
		expect(core.access.siteKeyFor({ id: createdProject.id }, policy.id)).not.toBe(siteKey);
		expect(core.access.siteKeyFor({ id: createdProject.id }, other.id)).toBe(otherKey);
		expect(core.accessPolicies.edgeSettings(policy.id).serviceTokens).toEqual([]);
	});
});

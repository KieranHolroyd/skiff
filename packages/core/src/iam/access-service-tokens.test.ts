import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { evaluateAccessEdge, sha256Hex, type AccessPolicyRule } from '@yoal/contracts';
import { buildPrincipal } from '../orgs.ts';
import { createCore, type Core } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';

/**
 * Named machine tokens for Yoal Access (IAM.md I25, §11.1). The migration file owns the table;
 * this test creates the same shape directly because `packages/db/src/migrations.ts` is regenerated
 * separately and 0106 is not in the checked-in snapshot yet.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-service-tokens-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-09T12:00:00Z');

opened.sqlite.exec(`
	CREATE TABLE IF NOT EXISTS access_service_tokens (
		id TEXT PRIMARY KEY,
		org_id TEXT NOT NULL,
		policy_id TEXT NOT NULL,
		name TEXT NOT NULL,
		header TEXT NOT NULL,
		token_hash TEXT NOT NULL UNIQUE,
		created_by TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER,
		revoked_at INTEGER
	);
	CREATE INDEX IF NOT EXISTS access_service_tokens_policy_idx
		ON access_service_tokens (policy_id, revoked_at);
`);

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
	clock = Date.parse('2026-11-09T12:00:00Z');
	opened.sqlite.exec(`
		DELETE FROM access_service_tokens;
		DELETE FROM access_policy_rules;
		DELETE FROM access_policies;
	`);
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

function createPolicy(rules: AccessPolicyRule[] = []) {
	return core.accessPolicies.create(admin, { name: 'CI', scope: { type: 'org' }, rules });
}

describe('access service tokens', () => {
	test('creation returns the secret once and stores only its hash', () => {
		const policy = createPolicy();
		const created = core.accessPolicies.createServiceToken(admin, policy.id, {
			name: 'Deploy',
			header: 'X-CI-Token',
		});

		expect(created.secret).toMatch(/^yoal_svc_/);
		expect(created.token.name).toBe('Deploy');
		expect(created.token.header).toBe('X-CI-Token');
		expect(created.token.revokedAt).toBeNull();

		const stored = opened.sqlite
			.query<{ token_hash: string; name: string }, [string]>(
				'SELECT token_hash, name FROM access_service_tokens WHERE policy_id = ?',
			)
			.all(policy.id);
		expect(stored).toHaveLength(1);
		expect(stored[0]!.token_hash).toBe(sha256Hex(created.secret));
		expect(JSON.stringify(stored)).not.toContain(created.secret);

		const listed = core.accessPolicies.listServiceTokens(admin, policy.id);
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ id: created.token.id, name: 'Deploy', lastUsedAt: null });
		expect(JSON.stringify(listed)).not.toContain(created.secret);
		expect(JSON.stringify(listed)).not.toContain(stored[0]!.token_hash);
	});

	test('the edge decision merges DB tokens with legacy policy rules', () => {
		const legacySecret = 'legacy-service-secret';
		const blockedSecret = 'blocked-service-secret';
		const policy = createPolicy([
			{
				idx: 0,
				action: 'allow',
				matcher: { type: 'serviceToken', header: 'X-Legacy', tokenHash: sha256Hex(legacySecret) },
			},
			{
				idx: 1,
				action: 'deny',
				matcher: { type: 'serviceToken', header: 'X-Blocked', tokenHash: sha256Hex(blockedSecret) },
			},
		]);
		const created = core.accessPolicies.createServiceToken(admin, policy.id, {
			name: 'Webhook',
			header: 'X-DB-Token',
		});
		const settings = core.accessPolicies.edgeSettings(policy.id);

		expect(settings.serviceTokens).toHaveLength(3);
		expect(settings.serviceTokens).toContainEqual({
			header: 'x-db-token',
			tokenHash: sha256Hex(created.secret),
			action: 'allow',
		});
		expect(
			evaluateAccessEdge(settings.serviceTokens, { 'x-legacy': legacySecret }, true),
		).toEqual({ decision: 'allow', header: 'x-legacy' });
		expect(
			evaluateAccessEdge(settings.serviceTokens, { 'x-db-token': created.secret }, true),
		).toEqual({ decision: 'allow', header: 'x-db-token' });
		// A legacy deny always beats an allow, including a DB token in the same policy.
		expect(
			evaluateAccessEdge(
				settings.serviceTokens,
				{ 'x-blocked': blockedSecret, 'x-db-token': created.secret },
				true,
			),
		).toEqual({ decision: 'deny', header: 'x-blocked' });
	});

	test('creation does not bump the policy version; revocation does', () => {
		const policy = createPolicy([{ idx: 0, action: 'allow', matcher: { type: 'anyMember' } }]);
		const version = core.accessPolicies.get(admin, policy.id).version;
		const created = core.accessPolicies.createServiceToken(admin, policy.id, {
			name: 'Deploy',
			header: 'X-CI-Token',
		});
		expect(core.accessPolicies.get(admin, policy.id).version).toBe(version);
		expect(core.accessPolicies.edgeSettings(policy.id).serviceTokens).toHaveLength(1);

		const revoked = core.accessPolicies.revokeServiceToken(admin, policy.id, created.token.id);
		expect(revoked.revokedAt).toBe(clock);
		expect(core.accessPolicies.get(admin, policy.id).version).toBe(version + 1);
		expect(core.accessPolicies.edgeSettings(policy.id).serviceTokens).toEqual([]);
		expect(core.accessPolicies.listServiceTokens(admin, policy.id)).toEqual([
			expect.objectContaining({ id: created.token.id, revokedAt: clock }),
		]);

		// Revoking again is a no-op: it must not sign visitors out twice.
		core.accessPolicies.revokeServiceToken(admin, policy.id, created.token.id);
		expect(core.accessPolicies.get(admin, policy.id).version).toBe(version + 1);
	});

	test('last-used is throttled to one update a minute', () => {
		const policy = createPolicy();
		const created = core.accessPolicies.createServiceToken(admin, policy.id, {
			name: 'Deploy',
			header: 'X-CI-Token',
		});
		const hash = sha256Hex(created.secret);

		expect(core.accessPolicies.touchServiceToken(policy.id, hash)).toBe(true);
		expect(core.accessPolicies.listServiceTokens(admin, policy.id)[0]!.lastUsedAt).toBe(clock);

		clock += 30_000;
		expect(core.accessPolicies.touchServiceToken(policy.id, hash)).toBe(false);
		expect(core.accessPolicies.listServiceTokens(admin, policy.id)[0]!.lastUsedAt).toBe(
			Date.parse('2026-11-09T12:00:00Z'),
		);

		clock += 31_000;
		expect(core.accessPolicies.touchServiceToken(policy.id, hash)).toBe(true);
		expect(core.accessPolicies.listServiceTokens(admin, policy.id)[0]!.lastUsedAt).toBe(clock);

		expect(core.accessPolicies.touchServiceToken(policy.id, 'f'.repeat(64))).toBe(false);

		core.accessPolicies.revokeServiceToken(admin, policy.id, created.token.id);
		expect(core.accessPolicies.touchServiceToken(policy.id, hash)).toBe(false);
	});

	test('listing, creating and revoking require accessPolicy permissions', () => {
		const policy = createPolicy();
		expect(() => core.accessPolicies.listServiceTokens(viewer, policy.id)).toThrow(/accessPolicy:read/);
		expect(() =>
			core.accessPolicies.createServiceToken(viewer, policy.id, { name: 'Nope', header: 'X-Nope' }),
		).toThrow(/accessPolicy:update/);

		const created = core.accessPolicies.createServiceToken(admin, policy.id, {
			name: 'Deploy',
			header: 'X-CI-Token',
		});
		expect(() =>
			core.accessPolicies.revokeServiceToken(viewer, policy.id, created.token.id),
		).toThrow(/accessPolicy:update/);
	});
});

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import type { Permission, Principal } from '@skiff/contracts';
import { ForbiddenError } from './errors.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-access-keys-'));
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

function principal(overrides: Partial<Parameters<typeof buildPrincipal>[0]> = {}): Principal {
	return buildPrincipal({
		kind: 'user',
		userId: 'user_1',
		orgId: 'org_1',
		role: 'owner',
		...overrides,
	});
}

/** A principal with exactly these permissions, for testing own-key versus org-wide behaviour. */
function limited(permissions: string[], overrides: Partial<Principal> = {}): Principal {
	return { ...principal(overrides), permissions: new Set(permissions as Permission[]) };
}

function row(id: string): { hash: string; last_used_at: number | null; last_used_ip_hash: string | null; revoked_at: number | null } {
	return opened.sqlite
		.query<{ hash: string; last_used_at: number | null; last_used_ip_hash: string | null; revoked_at: number | null }, [string]>(
			'SELECT hash, last_used_at, last_used_ip_hash, revoked_at FROM access_keys WHERE id = ?',
		)
		.get(id)!;
}

beforeEach(() => {
	now = Date.parse('2026-11-08T12:00:00Z');
	opened.sqlite.exec(`
		DELETE FROM access_keys;
		DELETE FROM service_accounts;
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

describe('access keys', () => {
	test('create returns the raw key once and stores only its sha256 hash', () => {
		const owner = principal();
		const created = core.ctx.accessKeys.create(owner, { name: '  CLI ' });

		expect(created.key).toMatch(/^skif_[A-Za-z0-9_-]+$/);
		expect(created.accessKey).toMatchObject({
			orgId: 'org_1',
			principalType: 'user',
			principalId: 'user_1',
			name: 'CLI',
			prefix: 'skif_',
			start: created.key.slice(0, 8),
			permissions: null,
			resources: null,
			allowedCidrs: [],
			expiresAt: null,
			lastUsedAt: null,
			lastUsedIpHash: null,
			createdBy: 'user_1',
			revokedAt: null,
			createdAt: now,
		});
		expect(created.accessKey.id).toMatch(/^ak_/);

		const stored = row(created.accessKey.id);
		expect(stored.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(stored.hash).not.toContain(created.key);

		const listed = core.ctx.accessKeys.list(owner);
		expect(listed).toEqual([created.accessKey]);
		// The raw key never comes back from a read.
		expect(JSON.stringify(listed)).not.toContain(created.key);
	});

	test('verify returns the row and records last use at most once a minute', () => {
		const owner = principal();
		const created = core.ctx.accessKeys.create(owner, { name: 'deploy' });

		const verified = core.ctx.accessKeys.verify(created.key);
		expect(verified).toEqual({
			orgId: 'org_1',
			principalType: 'user',
			principalId: 'user_1',
			permissions: undefined,
			resources: undefined,
			keyId: created.accessKey.id,
		});
		expect(row(created.accessKey.id).last_used_at).toBe(now);

		now += 30_000;
		expect(core.ctx.accessKeys.verify(created.key)).toBeDefined();
		expect(row(created.accessKey.id).last_used_at).toBe(now - 30_000);

		now += 31_000;
		expect(core.ctx.accessKeys.verify(created.key)).toBeDefined();
		expect(row(created.accessKey.id).last_used_at).toBe(now);
		expect(row(created.accessKey.id).last_used_ip_hash).toBeNull();
	});

	test('verify records a truncated hash of the IP, never the address', () => {
		const owner = principal();
		const created = core.ctx.accessKeys.create(owner, { name: 'deploy' });
		core.ctx.accessKeys.verify(created.key, { ip: '203.0.113.9' });
		const ipHash = row(created.accessKey.id).last_used_ip_hash;
		expect(ipHash).toMatch(/^[0-9a-f]{16}$/);
		expect(ipHash).not.toContain('203.0.113.9');
	});

	test('an unknown or non-Skiff key does not verify', () => {
		expect(core.ctx.accessKeys.verify('skif_missing')).toBeUndefined();
		expect(core.ctx.accessKeys.verify('not-a-key')).toBeUndefined();
	});

	test('expired keys stop verifying', () => {
		const owner = principal();
		const created = core.ctx.accessKeys.create(owner, { name: 'short', expiresInSeconds: 60 });
		expect(created.accessKey.expiresAt).toBe(now + 60_000);
		expect(core.ctx.accessKeys.verify(created.key)).toBeDefined();

		now += 60_001;
		expect(core.ctx.accessKeys.verify(created.key)).toBeUndefined();
	});

	test('allowed CIDRs are enforced and fail closed without an IP', () => {
		const owner = principal();
		const created = core.ctx.accessKeys.create(owner, {
			name: 'office',
			allowedCidrs: ['10.0.0.0/8', '192.168.1.10'],
		});
		expect(core.ctx.accessKeys.verify(created.key)).toBeUndefined();
		expect(core.ctx.accessKeys.verify(created.key, { ip: '10.1.2.3' })).toBeDefined();
		expect(core.ctx.accessKeys.verify(created.key, { ip: '192.168.1.10' })).toBeDefined();
		expect(core.ctx.accessKeys.verify(created.key, { ip: '192.168.1.11' })).toBeUndefined();
	});

	test('revoke is idempotent, rejects the key and needs revoke-any for someone else', () => {
		const owner = principal();
		const created = core.ctx.accessKeys.create(owner, { name: 'deploy' });
		const revoked = core.ctx.accessKeys.revoke(owner, created.accessKey.id);
		expect(revoked.revokedAt).toBe(now);
		expect(core.ctx.accessKeys.verify(created.key)).toBeUndefined();

		now += 1_000;
		expect(core.ctx.accessKeys.revoke(owner, created.accessKey.id).revokedAt).toBe(now - 1_000);

		const userOnly = limited(['accessKey:read', 'accessKey:create', 'accessKey:revoke'], {
			userId: 'user_2',
		});
		expect(() => core.ctx.accessKeys.revoke(userOnly, created.accessKey.id)).toThrow(ForbiddenError);
	});

	test('a principal without accessKey:read-all sees and revokes only its own keys', () => {
		const owner = principal();
		const first = core.ctx.accessKeys.create(owner, { name: 'first' });
		const second = core.ctx.accessKeys.create(principal({ userId: 'user_2' }), { name: 'second' });

		const ownOnly = limited(['accessKey:create', 'accessKey:read', 'accessKey:revoke'], {
			userId: 'user_1',
		});
		expect(core.ctx.accessKeys.list(ownOnly).map((key) => key.id)).toEqual([first.accessKey.id]);
		expect(() => core.ctx.accessKeys.list(ownOnly, { principalId: 'user_2' })).toThrow(ForbiddenError);
		expect(() => core.ctx.accessKeys.revoke(ownOnly, second.accessKey.id)).toThrow(ForbiddenError);

		// The owner holds read-all/revoke-any, so it sees and can revoke both.
		expect(core.ctx.accessKeys.list(owner)).toHaveLength(2);
		core.ctx.accessKeys.revoke(owner, second.accessKey.id);
		expect(core.ctx.accessKeys.verify(second.key)).toBeUndefined();
	});

	test('keys are scoped to their org', () => {
		const owner = principal();
		const created = core.ctx.accessKeys.create(owner, { name: 'deploy' });
		const otherOrg = principal({ orgId: 'org_2', userId: 'user_9' });

		expect(core.ctx.accessKeys.list(otherOrg)).toEqual([]);
		expect(() => core.ctx.accessKeys.revoke(otherOrg, created.accessKey.id)).toThrow(/not found/);
		// Verification is global by hash, but reports the key's own org.
		expect(core.ctx.accessKeys.verify(created.key)?.orgId).toBe('org_1');
	});

	test('the restriction is returned by verify and shown in the list', () => {
		const owner = principal();
		const created = core.ctx.accessKeys.create(owner, {
			name: 'narrowed',
			permissions: ['project:read', 'deployment:read'],
			resources: ['project:p1', 'database:*'],
		});
		expect(created.accessKey.permissions).toEqual(['project:read', 'deployment:read']);
		expect(created.accessKey.resources).toEqual(['project:p1', 'database:*']);
		expect(core.ctx.accessKeys.verify(created.key)).toMatchObject({
			permissions: ['project:read', 'deployment:read'],
			resources: ['project:p1', 'database:*'],
		});
	});

	test('create validates its input', () => {
		const owner = principal();
		expect(() => core.ctx.accessKeys.create(owner, { name: '' })).toThrow(/1–100/);
		expect(() => core.ctx.accessKeys.create(owner, { name: 'x', permissions: ['project:*'] })).toThrow(
			/not a permission/,
		);
		expect(() => core.ctx.accessKeys.create(owner, { name: 'x', resources: ['project'] })).toThrow(
			/resource limit/,
		);
		expect(() => core.ctx.accessKeys.create(owner, { name: 'x', allowedCidrs: ['10.0.0.0/33'] })).toThrow(
			/IPv4/,
		);
		expect(() => core.ctx.accessKeys.create(owner, { name: 'x', expiresInSeconds: 0 })).toThrow(
			/positive/,
		);
		expect(() => core.ctx.accessKeys.create(owner, { name: 'x', principalId: 'user_2' })).toThrow(
			/yourself/,
		);
		expect(() => core.ctx.accessKeys.create(limited([], { role: 'viewer' }), { name: 'x' })).toThrow(
			ForbiddenError,
		);
	});

	test('service-account keys default to 90 days and verify as the account', () => {
		const owner = principal();
		const account = core.ctx.serviceAccounts.create(owner, { name: 'ci-bot' });
		const created = core.ctx.accessKeys.create(owner, {
			principalType: 'serviceAccount',
			principalId: account.id,
			name: 'ci',
			permissions: ['project:read'],
		});

		expect(created.accessKey.expiresAt).toBe(now + 90 * 24 * 60 * 60 * 1000);
		expect(created.accessKey.principalType).toBe('serviceAccount');
		expect(core.ctx.accessKeys.verify(created.key)).toMatchObject({
			orgId: 'org_1',
			principalType: 'serviceAccount',
			principalId: account.id,
			permissions: ['project:read'],
		});

		// Disabling the account is its off-switch: its keys stop verifying.
		core.ctx.serviceAccounts.update(owner, account.id, { disabled: true });
		expect(core.ctx.accessKeys.verify(created.key)).toBeUndefined();
	});

	test('a service-account key needs manage-keys and an account in the same org', () => {
		const owner = principal();
		const account = core.ctx.serviceAccounts.create(owner, { name: 'ci-bot' });
		expect(() =>
			core.ctx.accessKeys.create(limited(['accessKey:create']), {
				principalType: 'serviceAccount',
				principalId: account.id,
				name: 'ci',
			}),
		).toThrow(ForbiddenError);

		const otherOrg = principal({ orgId: 'org_2', userId: 'user_9' });
		expect(() =>
			core.ctx.accessKeys.create(otherOrg, {
				principalType: 'serviceAccount',
				principalId: account.id,
				name: 'ci',
			}),
		).toThrow(/not found/);
	});

	test('a service-account key is listed for that account, not as a user key', () => {
		const owner = principal();
		const account = core.ctx.serviceAccounts.create(owner, { name: 'ci-bot' });
		const created = core.ctx.accessKeys.create(owner, {
			principalType: 'serviceAccount',
			principalId: account.id,
			name: 'ci',
		});
		const userOnly = limited(['accessKey:read'], { userId: 'user_1' });
		expect(core.ctx.accessKeys.list(userOnly)).toEqual([]);

		const accountPrincipal: Principal = {
			kind: 'serviceAccount',
			userId: account.id,
			orgId: 'org_1',
			role: 'viewer',
			permissions: new Set(['accessKey:read']),
		};
		expect(core.ctx.accessKeys.list(accountPrincipal).map((key) => key.id)).toEqual([
			created.accessKey.id,
		]);
	});
});

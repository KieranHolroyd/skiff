import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import type { Permission, Principal } from '@yoal/contracts';
import { ForbiddenError } from './errors.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-access-keys-'));
const opened = createDb({ path: ':memory:' });
let now = Date.parse('2026-11-08T12:00:00Z');
let core: Core;
let apiKeySequence = 0;

/**
 * Exactly what `@better-auth/api-key` 1.7.15's `defaultKeyHasher` does:
 * `base64url(sha256(utf8(raw)))` with no padding.
 */
function betterAuthHash(raw: string): string {
	return createHash('sha256').update(raw).digest('base64url');
}

function addMembership(userId: string, orgId = 'org_1', createdAt = '2026-01-01T00:00:00.000Z'): void {
	opened.sqlite.run(
		'INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)',
		[`mem_${userId}_${orgId}`, orgId, userId, 'owner', createdAt],
	);
}

/** Insert a Better Auth `apikey` row, including the hash its plugin would have stored. */
function insertApiKey(
	overrides: {
		raw?: string;
		referenceId?: string;
		name?: string | null;
		prefix?: string | null;
		start?: string | null;
		enabled?: boolean;
		expiresAt?: string | null;
		createdAt?: string;
		lastRequest?: string | null;
		metadata?: string | null;
		hash?: string;
	} = {},
): { id: string; raw: string; hash: string } {
	apiKeySequence++;
	const raw =
		overrides.raw ??
		`yoal_${'A'.repeat(63)}${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[apiKeySequence % 26]}`;
	const id = `apikey_${apiKeySequence}`;
	const hash = overrides.hash ?? betterAuthHash(raw);
	opened.sqlite.run(
		`INSERT INTO apikey
		   (id, referenceId, name, prefix, start, key, enabled, expiresAt, createdAt, lastRequest, metadata)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			overrides.referenceId ?? 'user_1',
			overrides.name === undefined ? 'Legacy CLI' : overrides.name,
			overrides.prefix === undefined ? 'yoal_' : overrides.prefix,
			overrides.start === undefined ? 'yoal_A' : overrides.start,
			hash,
			overrides.enabled === false ? 0 : 1,
			overrides.expiresAt === undefined ? '2026-12-01T00:00:00.000Z' : overrides.expiresAt,
			overrides.createdAt ?? '2026-11-01T00:00:00.000Z',
			overrides.lastRequest ?? null,
			overrides.metadata === undefined
				? JSON.stringify({ scopes: ['project:read'], orgId: 'org_1' })
				: overrides.metadata,
		],
	);
	return { id, raw, hash };
}

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
	apiKeySequence = 0;
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
		CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, lastOrganizationId TEXT);
		DELETE FROM user;
		CREATE TABLE IF NOT EXISTS apikey (
			id TEXT PRIMARY KEY,
			referenceId TEXT NOT NULL,
			name TEXT,
			prefix TEXT,
			start TEXT,
			key TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			expiresAt TEXT,
			createdAt TEXT NOT NULL,
			lastRequest TEXT,
			metadata TEXT
		);
		DELETE FROM apikey;
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

		expect(created.key).toMatch(/^yoal_[A-Za-z0-9_-]+$/);
		expect(created.accessKey).toMatchObject({
			orgId: 'org_1',
			principalType: 'user',
			principalId: 'user_1',
			name: 'CLI',
			prefix: 'yoal_',
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

	test('an unknown or non-Yoal key does not verify', () => {
		expect(core.ctx.accessKeys.verify('yoal_missing')).toBeUndefined();
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

describe('Better Auth key migration (spike S1)', () => {
	test('a Better Auth hash verifies, and scopes/expiry/start are preserved', () => {
		addMembership('user_1');
		const legacy = insertApiKey({
			name: 'Legacy CLI',
			start: 'yoal_A',
			metadata: JSON.stringify({
				scopes: ['project:read', 'deployment:read', 'not-a-permission'],
				orgId: 'org_1',
			}),
			expiresAt: '2026-12-01T00:00:00.000Z',
			createdAt: '2026-11-01T00:00:00.000Z',
		});
		expect(legacy.hash).toMatch(/^[A-Za-z0-9_-]{43}$/);

		// Better Auth's format is 43 base64url characters, not Yoal's 64 hex characters.
		expect(legacy.hash).toBe(betterAuthHash(legacy.raw));

		const result = core.ctx.accessKeys.migrateBetterAuthKeys('org_1', principal());
		expect(result).toEqual({
			examined: 1,
			migrated: 1,
			alreadyMigrated: 0,
			disabled: 0,
			skippedNoOrg: 0,
			skippedOtherOrg: 0,
			skippedInvalid: 0,
		});

		const verified = core.ctx.accessKeys.verify(legacy.raw);
		expect(verified).toMatchObject({
			orgId: 'org_1',
			principalType: 'user',
			principalId: 'user_1',
			permissions: ['project:read', 'deployment:read'],
			resources: undefined,
		});
		expect(verified?.keyId).toMatch(/^ak_/);

		const stored = opened.sqlite
			.query<{
				hash: string;
				hash_scheme: string;
				name: string;
				prefix: string;
				start: string;
				restriction_json: string;
				expires_at: number | null;
				created_at: number;
			}, [string]>(
				`SELECT hash, hash_scheme, name, prefix, start, restriction_json, expires_at, created_at
				   FROM access_keys WHERE id = ?`,
			)
			.get(verified!.keyId)!;
		expect(stored).toMatchObject({
			hash: betterAuthHash(legacy.raw),
			hash_scheme: 'better-auth',
			name: 'Legacy CLI',
			prefix: 'yoal_',
			start: 'yoal_A',
			expires_at: Date.parse('2026-12-01T00:00:00.000Z'),
			created_at: Date.parse('2026-11-01T00:00:00.000Z'),
		});
		expect(JSON.parse(stored.restriction_json)).toEqual({
			permissions: ['project:read', 'deployment:read'],
		});
	});

	test('migration is idempotent by hash and leaves the apikey row for the fallback', () => {
		addMembership('user_1');
		const legacy = insertApiKey();

		// Before the copy, `verify` has no row: the control plane's Better Auth fallback handles it.
		expect(core.ctx.accessKeys.verify(legacy.raw)).toBeUndefined();

		const first = core.ctx.accessKeys.migrateBetterAuthKeys(undefined, principal());
		expect(first).toMatchObject({ examined: 1, migrated: 1, alreadyMigrated: 0 });
		expect(core.ctx.accessKeys.verify(legacy.raw)).toBeDefined();

		const second = core.ctx.accessKeys.migrateBetterAuthKeys(undefined, principal());
		expect(second).toMatchObject({ examined: 1, migrated: 0, alreadyMigrated: 1 });
		expect(
			opened.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM access_keys').get()?.count,
		).toBe(1);
		// The migration never deletes Better Auth's source rows.
		expect(
			opened.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM apikey').get()?.count,
		).toBe(1);
	});

	test('an expired Better Auth key keeps its expiry and still does not verify', () => {
		addMembership('user_1');
		const legacy = insertApiKey({ expiresAt: '2026-11-08T11:59:00.000Z' });

		expect(core.ctx.accessKeys.migrateBetterAuthKeys('org_1', principal()).migrated).toBe(1);
		expect(core.ctx.accessKeys.verify(legacy.raw)).toBeUndefined();
		const stored = opened.sqlite
			.query<{ expires_at: number | null }, [string]>('SELECT expires_at FROM access_keys WHERE hash = ?')
			.get(betterAuthHash(legacy.raw));
		expect(stored?.expires_at).toBe(Date.parse('2026-11-08T11:59:00.000Z'));
	});

	test('a disabled Better Auth key is migrated already revoked', () => {
		addMembership('user_1');
		const legacy = insertApiKey({ enabled: false });

		const result = core.ctx.accessKeys.migrateBetterAuthKeys('org_1', principal());
		expect(result).toMatchObject({ migrated: 1, disabled: 1 });
		expect(core.ctx.accessKeys.verify(legacy.raw)).toBeUndefined();
		const stored = opened.sqlite
			.query<{ revoked_at: number | null }, [string]>('SELECT revoked_at FROM access_keys WHERE hash = ?')
			.get(betterAuthHash(legacy.raw));
		expect(stored?.revoked_at).toBe(now);
	});

	test('a key whose owner has no org is skipped, and an org read-all caller is pinned to its org', () => {
		addMembership('user_1', 'org_2');
		const otherOrg = insertApiKey({ referenceId: 'user_1' });
		const noOrg = insertApiKey({ referenceId: 'user_without_org', start: 'yoal_B' });

		const orgOne = limited(['accessKey:read', 'accessKey:read-all']);
		const result = core.ctx.accessKeys.migrateBetterAuthKeys('org_2', orgOne);
		// The caller's own org wins over the argument, so org_2 is out of scope and no-org is skipped.
		expect(result).toMatchObject({
			examined: 2,
			migrated: 0,
			skippedOtherOrg: 1,
			skippedNoOrg: 1,
		});
		expect(core.ctx.accessKeys.verify(otherOrg.raw)).toBeUndefined();
		expect(core.ctx.accessKeys.verify(noOrg.raw)).toBeUndefined();
	});

	test('a raw or unhashed apikey row is reported as unmigratable', () => {
		addMembership('user_1');
		const raw = `yoal_${'B'.repeat(64)}`;
		const legacy = insertApiKey({ raw, hash: raw });

		const result = core.ctx.accessKeys.migrateBetterAuthKeys('org_1', principal());
		expect(result).toMatchObject({ examined: 1, migrated: 0, skippedInvalid: 1 });
		expect(core.ctx.accessKeys.recognizes(legacy.raw)).toBe(false);
	});

	test('a revoked migrated key is still recognised, so the Better Auth fallback cannot revive it', () => {
		addMembership('user_1');
		const legacy = insertApiKey();

		expect(core.ctx.accessKeys.recognizes(legacy.raw)).toBe(false);
		core.ctx.accessKeys.migrateBetterAuthKeys('org_1', principal());
		expect(core.ctx.accessKeys.recognizes(legacy.raw)).toBe(true);

		const created = core.ctx.accessKeys.list(principal())[0]!;
		core.ctx.accessKeys.revoke(principal(), created.id);
		expect(core.ctx.accessKeys.verify(legacy.raw)).toBeUndefined();
		// The principal.ts fallback gate uses this: `true` means the apikey row must not be tried.
		expect(core.ctx.accessKeys.recognizes(legacy.raw)).toBe(true);
	});

	test('a non-platform caller without accessKey:read-all cannot run the migration', () => {
		addMembership('user_1');
		insertApiKey();
		expect(() =>
			core.ctx.accessKeys.migrateBetterAuthKeys(undefined, limited(['accessKey:read'])),
		).toThrow(ForbiddenError);
	});
});

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import type { Principal } from '@skiff/contracts';
import { ForbiddenError } from '../errors.ts';
import { createCore, type Core } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';
import { buildPrincipal } from '../orgs.ts';
import { hashScimToken, mintScimToken, SCIM_TOKEN_PREFIX } from './scim.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-scim-'));
const opened = createDb({ path: ':memory:' });
let now = Date.parse('2026-11-08T12:00:00Z');

function open(): Core {
	return createCore({
		db: opened.db,
		sqlite: opened.sqlite,
		version: '0.1.0',
		config: {
			dataDir: dir,
			platformOrigin: 'https://control.test',
			contentDomain: 'sites.test',
			objectStore: new LocalObjectStore(
				join(dir, 'objects'),
				'https://control.test',
				'object-secret-123'
			),
			masterKey: new Uint8Array(32).fill(7),
			siteCookieSecret: 'site-cookie-secret-123',
			objectStoreSecret: 'object-secret-123',
			desiredAgentVersion: '0.1.0',
			now: () => now
		}
	});
}

function principal(role: 'owner' | 'viewer' = 'owner'): Principal {
	return buildPrincipal({
		kind: 'user',
		userId: 'user_1',
		orgId: 'org_1',
		role
	});
}

/** The SCIM tables are boot-migrated by Better Auth, so unit tests create the shape they read. */
function schemas(): void {
	opened.sqlite.exec(`
		CREATE TABLE IF NOT EXISTS member (id TEXT PRIMARY KEY, organizationId TEXT, userId TEXT, role TEXT, createdAt TEXT);
		CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, banned INTEGER DEFAULT 0, banReason TEXT);
		CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, userId TEXT);
		CREATE TABLE IF NOT EXISTS oauthAccessToken (id TEXT PRIMARY KEY, userId TEXT);
		CREATE TABLE IF NOT EXISTS oauthRefreshToken (id TEXT PRIMARY KEY, userId TEXT);
		CREATE TABLE IF NOT EXISTS oauthConsent (id TEXT PRIMARY KEY, userId TEXT);
		CREATE TABLE IF NOT EXISTS oauth_client_usage (user_id TEXT, client_id TEXT, last_used_at INTEGER, PRIMARY KEY (user_id, client_id));
		CREATE TABLE IF NOT EXISTS scim_tokens (
			id TEXT PRIMARY KEY, org_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
			created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
		);
		CREATE TABLE IF NOT EXISTS "scimUser" (
			id TEXT PRIMARY KEY, connectionId TEXT, provisioningDomainId TEXT, userId TEXT, active INTEGER
		);
		CREATE TABLE IF NOT EXISTS "scimGroup" (
			id TEXT PRIMARY KEY, connectionId TEXT, provisioningDomainId TEXT, displayName TEXT, externalId TEXT
		);
		CREATE TABLE IF NOT EXISTS "scimGroupMember" (groupId TEXT, scimUserId TEXT);
	`);
}

beforeEach(() => {
	now = Date.parse('2026-11-08T12:00:00Z');
	schemas();
	opened.sqlite.exec(`
		DELETE FROM member;
		DELETE FROM "user";
		DELETE FROM session;
		DELETE FROM oauthAccessToken;
		DELETE FROM oauthRefreshToken;
		DELETE FROM oauthConsent;
		DELETE FROM oauth_client_usage;
		DELETE FROM scim_tokens;
		DELETE FROM "scimUser";
		DELETE FROM "scimGroup";
		DELETE FROM "scimGroupMember";
		DELETE FROM iam_group_members;
		DELETE FROM iam_groups;
		DELETE FROM access_keys;
	`);
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('SCIM token hashing', () => {
	test('mints a prefixed, random token', () => {
		const token = mintScimToken();
		expect(token.startsWith(SCIM_TOKEN_PREFIX)).toBe(true);
		expect(token).not.toBe(mintScimToken());
	});

	test('hashes deterministically and never returns the raw value', () => {
		expect(hashScimToken('  scim_abc  ')).toBe(hashScimToken('scim_abc'));
		expect(hashScimToken('scim_abc')).not.toBe(hashScimToken('scim_abd'));
		expect(hashScimToken('scim_abc')).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('ScimTokenService', () => {
	test('create shows the token once and verify resolves its organisation', () => {
		const core = open();
		const created = core.scim.create(principal());
		expect(created.token.startsWith(SCIM_TOKEN_PREFIX)).toBe(true);
		expect(created.scimToken).not.toHaveProperty('token');

		expect(core.scim.verify(created.token)).toMatchObject({
			orgId: 'org_1',
			tokenId: created.scimToken.id
		});
		expect(core.scim.verify('scim_not_a_token')).toBeNull();
	});

	test('revoking makes the token unusable', () => {
		const core = open();
		const created = core.scim.create(principal());
		core.scim.revoke(principal(), created.scimToken.id);
		expect(core.scim.verify(created.token)).toBeNull();
		expect(core.scim.list(principal())[0]?.revokedAt).not.toBeNull();
	});

	test('rotating revokes the previous active token', () => {
		const core = open();
		const first = core.scim.create(principal());
		const second = core.scim.rotate(principal());
		expect(core.scim.verify(first.token)).toBeNull();
		expect(core.scim.verify(second.token)?.orgId).toBe('org_1');
	});

	test('a non-manager cannot mint a token', () => {
		const core = open();
		expect(() => core.scim.create(principal('viewer'))).toThrow(ForbiddenError);
	});
});

describe('SCIM reconciliation', () => {
	test('deactivation revokes sessions, OAuth grants and the user’s access keys', () => {
		const core = open();
		opened.sqlite.run(`INSERT INTO "user" (id, banned) VALUES ('user_leaver', 0)`);
		opened.sqlite.run("INSERT INTO session (id, userId) VALUES ('ses_1', 'user_leaver')");
		opened.sqlite.run("INSERT INTO oauthAccessToken (id, userId) VALUES ('oat_1', 'user_leaver')");
		opened.sqlite.run("INSERT INTO oauthConsent (id, userId) VALUES ('con_1', 'user_leaver')");
		opened.sqlite.run(
			`INSERT INTO access_keys
			   (id, org_id, principal_type, principal_id, name, prefix, start, hash, restriction_json,
			    allowed_cidrs, expires_at, last_used_at, last_used_ip_hash, created_by, revoked_at, created_at)
			 VALUES ('ak_1', 'org_1', 'user', 'user_leaver', 'cli', 'skif_', 'skif_abc',
			         'hash', '{}', '[]', NULL, NULL, NULL, 'user_leaver', NULL, ?)`,
			[now]
		);
		opened.sqlite.run(
			`INSERT INTO "scimUser" (id, connectionId, provisioningDomainId, userId, active)
			 VALUES ('scimu_1', 'org_1', 'org_1', 'user_leaver', 0)`
		);

		const result = core.scim.syncFromScim();
		expect(result.users).toBe(1);
		expect(
			opened.sqlite
				.query<{ banned: number }, [string]>('SELECT banned FROM "user" WHERE id = ?')
				.get('user_leaver')?.banned
		).toBe(1);
		expect(
			opened.sqlite
				.query<{ n: number }, [string]>('SELECT count(*) AS n FROM session WHERE userId = ?')
				.get('user_leaver')?.n
		).toBe(0);
		expect(
			opened.sqlite
				.query<{ n: number }, [string]>(
					'SELECT count(*) AS n FROM oauthAccessToken WHERE userId = ?'
				)
				.get('user_leaver')?.n
		).toBe(0);
		expect(
			opened.sqlite
				.query<{ revoked_at: number | null }, [string]>(
					'SELECT revoked_at FROM access_keys WHERE id = ?'
				)
				.get('ak_1')?.revoked_at
		).not.toBeNull();
	});

	test('an active SCIM user becomes a member with the default role', () => {
		const core = open();
		opened.sqlite.run(`INSERT INTO "user" (id, banned) VALUES ('user_new', 0)`);
		opened.sqlite.run(
			`INSERT INTO "scimUser" (id, connectionId, provisioningDomainId, userId, active)
			 VALUES ('scimu_2', 'org_1', 'org_1', 'user_new', 1)`
		);

		expect(core.scim.syncFromScim().users).toBe(1);
		expect(
			opened.sqlite
				.query<{ role: string }, []>(
					"SELECT role FROM member WHERE organizationId = 'org_1' AND userId = 'user_new'"
				)
				.get()?.role
		).toBe('viewer');
	});

	test('SCIM groups mirror into iam_groups with SCIM-sourced membership', () => {
		const core = open();
		opened.sqlite.run(`INSERT INTO "user" (id, banned) VALUES ('user_new', 0)`);
		opened.sqlite.run(
			`INSERT INTO member (id, organizationId, userId, role, createdAt)
			 VALUES ('mem_new', 'org_1', 'user_new', 'viewer', ?)`,
			[new Date(now).toISOString()]
		);
		opened.sqlite.run(
			`INSERT INTO "scimUser" (id, connectionId, provisioningDomainId, userId, active)
			 VALUES ('scimu_3', 'org_1', 'org_1', 'user_new', 1)`
		);
		opened.sqlite.run(
			`INSERT INTO "scimGroup" (id, connectionId, provisioningDomainId, displayName, externalId)
			 VALUES ('scimg_1', 'org_1', 'org_1', 'Engineering', 'ext-1')`
		);
		opened.sqlite.run(
			`INSERT INTO "scimGroupMember" (groupId, scimUserId) VALUES ('scimg_1', 'scimu_3')`
		);

		core.scim.syncFromScim();
		const group = opened.sqlite
			.query<{ id: string; source: string }, []>(
				"SELECT id, source FROM iam_groups WHERE org_id = 'org_1' AND external_id = 'ext-1'"
			)
			.get();
		expect(group?.source).toBe('scim');
		expect(
			opened.sqlite
				.query<{ source: string }, [string, string]>(
					'SELECT source FROM iam_group_members WHERE group_id = ? AND user_id = ?'
				)
				.get(group!.id, 'user_new')?.source
		).toBe('scim');
	});
});

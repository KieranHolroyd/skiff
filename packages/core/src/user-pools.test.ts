import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import type { Permission, Principal } from '@yoal/contracts';
import { ForbiddenError, NotFoundError } from './errors.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-user-pools-'));
const opened = createDb({ path: ':memory:' });
opened.sqlite.exec(
	readFileSync(new URL('../../db/migrations/0101_user_pool_passkeys.sql', import.meta.url), 'utf8')
);
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

function principal(
	overrides: Partial<Parameters<typeof buildPrincipal>[0]> = {}
): Principal {
	return buildPrincipal({
		kind: 'user',
		userId: 'user_1',
		orgId: 'org_1',
		role: 'owner',
		...overrides
	});
}

beforeEach(() => {
	now = Date.parse('2026-11-08T12:00:00Z');
	// `packages/db/src/migrations.ts` is generated at release time and this slice deliberately does
	// not regenerate it. Create the tables here so the service tests do not depend on that step.
	opened.sqlite.exec(`
		CREATE TABLE IF NOT EXISTS user_pools (
			id TEXT PRIMARY KEY,
			org_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			engine TEXT NOT NULL DEFAULT 'yoal-identity',
			issuer TEXT NOT NULL,
			signing_key_id TEXT,
			signup_mode TEXT NOT NULL DEFAULT 'invite',
			theme_json TEXT NOT NULL DEFAULT '{}',
			created_by TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			disabled_at INTEGER
		);
		CREATE UNIQUE INDEX IF NOT EXISTS user_pools_org_name_idx ON user_pools (org_id, name);
		CREATE UNIQUE INDEX IF NOT EXISTS user_pools_issuer_idx ON user_pools (issuer);
		CREATE TABLE IF NOT EXISTS user_pool_clients (
			id TEXT PRIMARY KEY,
			pool_id TEXT NOT NULL,
			name TEXT NOT NULL,
			client_id TEXT NOT NULL,
			client_secret_sealed TEXT,
			redirect_uris_json TEXT NOT NULL DEFAULT '[]',
			public INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL
		);
		CREATE UNIQUE INDEX IF NOT EXISTS user_pool_clients_pool_name_idx
			ON user_pool_clients (pool_id, name);
		CREATE UNIQUE INDEX IF NOT EXISTS user_pool_clients_client_id_idx
			ON user_pool_clients (client_id);
		DELETE FROM user_pool_clients;
		DELETE FROM user_pools;
		DELETE FROM signing_keys;
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

describe('user pools', () => {
	test('create normalises the name, generates an issuer and signs with a new key', async () => {
		const owner = principal();
		const pool = await core.userPools.create(owner, {
			name: '  Shop ',
			description: 'Customers of the shop',
			signupMode: 'open'
		});

		expect(pool).toMatchObject({
			orgId: 'org_1',
			name: 'shop',
			description: 'Customers of the shop',
			engine: 'yoal-identity',
			signupMode: 'open',
			disabled: false,
			disabledAt: null,
			createdBy: 'user_1',
			createdAt: now,
			updatedAt: now
		});
		expect(pool.id).toMatch(/^up_/);
		expect(pool.issuer).toBe(`https://auth.sites.test/${pool.id}`);
		expect(pool.signingKeyId).toMatch(/^k_/);
		expect(core.userPools.list(owner)).toEqual([pool]);
		expect(core.userPools.get(owner, pool.id)).toEqual(pool);

		const key = opened.sqlite
			.query<{ purpose: string; state: string }, [string]>(
				'SELECT purpose, state FROM signing_keys WHERE kid = ?'
			)
			.get(pool.signingKeyId!);
		expect(key).toEqual({ purpose: `pool:${pool.id}`, state: 'active' });
	});

	test('a name is unique per organisation, and the issuer is unique and id-based', async () => {
		const owner = principal();
		const first = await core.userPools.create(owner, { name: 'shop' });
		await expect(core.userPools.create(owner, { name: 'SHOP' })).rejects.toThrow(/already exists/);

		const second = await core.userPools.create(principal({ orgId: 'org_2' }), { name: 'shop' });
		expect(second.name).toBe('shop');
		expect(second.issuer).not.toBe(first.issuer);
		expect(second.issuer.endsWith(second.id)).toBe(true);
	});

	test('reads and writes are scoped to the organisation', async () => {
		const owner = principal();
		const other = principal({ orgId: 'org_2' });
		const pool = await core.userPools.create(owner, { name: 'shop' });

		expect(() => core.userPools.get(other, pool.id)).toThrow(NotFoundError);
		expect(() => core.userPools.listClients(other, pool.id)).toThrow(NotFoundError);
		expect(core.userPools.list(other)).toEqual([]);
		expect(() => core.userPools.update(other, pool.id, { disabled: true })).toThrow(NotFoundError);
		expect(() => core.userPools.delete(other, pool.id)).toThrow(NotFoundError);
	});

	test('disable keeps the pool and its clients and can be reversed', async () => {
		const owner = principal();
		const pool = await core.userPools.create(owner, { name: 'shop' });
		core.userPools.createClient(owner, pool.id, {
			name: 'web',
			redirectUris: ['https://shop.test/callback']
		});

		now += 60_000;
		const disabled = core.userPools.update(owner, pool.id, { disabled: true });
		expect(disabled).toMatchObject({ disabled: true, disabledAt: now });
		expect(core.userPools.list(owner)[0]?.disabled).toBe(true);
		expect(core.userPools.listClients(owner, pool.id)).toHaveLength(1);

		now += 60_000;
		const enabled = core.userPools.update(owner, pool.id, { disabled: false });
		expect(enabled).toMatchObject({ disabled: false, disabledAt: null });
	});

	test('client secrets are sealed with the org key and returned exactly once', async () => {
		const owner = principal();
		const pool = await core.userPools.create(owner, { name: 'shop' });
		const created = core.userPools.createClient(owner, pool.id, {
			name: 'web',
			redirectUris: ['https://shop.test/callback', 'https://www.shop.test/callback']
		});

		expect(created.client).toMatchObject({
			poolId: pool.id,
			name: 'web',
			public: false,
			redirectUris: ['https://shop.test/callback', 'https://www.shop.test/callback']
		});
		expect(created.client.clientId).toMatch(/^upc_/);
		expect(created.clientSecret).toBeTruthy();
		expect(created.client).not.toHaveProperty('clientSecret');

		const row = opened.sqlite
			.query<{ client_secret_sealed: string | null }, [string]>(
				'SELECT client_secret_sealed FROM user_pool_clients WHERE id = ?'
			)
			.get(created.client.id);
		const clientSecret = created.clientSecret!;
		expect(row?.client_secret_sealed).toBeTruthy();
		expect(row?.client_secret_sealed).not.toBe(clientSecret);
		expect(core.ctx.secrets.open('org_1', row!.client_secret_sealed!)).toBe(clientSecret);
		expect(core.userPools.listClients(owner, pool.id)).toEqual([created.client]);
	});

	test('a public client has no secret and needs only PKCE', async () => {
		const owner = principal();
		const pool = await core.userPools.create(owner, { name: 'shop' });
		const created = core.userPools.createClient(owner, pool.id, {
			name: 'spa',
			redirectUris: ['https://shop.test/callback'],
			public: true
		});

		expect(created.client.public).toBe(true);
		expect(created.clientSecret).toBeNull();
		const row = opened.sqlite
			.query<{ client_secret_sealed: string | null }, [string]>(
				'SELECT client_secret_sealed FROM user_pool_clients WHERE id = ?'
			)
			.get(created.client.id);
		expect(row?.client_secret_sealed).toBeNull();
	});

	test('clients are unique per pool and can be removed by row id or OIDC client id', async () => {
		const owner = principal();
		const pool = await core.userPools.create(owner, { name: 'shop' });
		const first = core.userPools.createClient(owner, pool.id, {
			name: 'web',
			redirectUris: ['https://shop.test/callback']
		});
		expect(() =>
			core.userPools.createClient(owner, pool.id, {
				name: 'web',
				redirectUris: ['https://other.test/callback']
			})
		).toThrow(/already exists/);

		const second = core.userPools.createClient(owner, pool.id, {
			name: 'mobile',
			redirectUris: ['com.example.shop:/callback'],
			public: true
		});
		core.userPools.deleteClient(owner, pool.id, second.client.clientId);
		expect(core.userPools.listClients(owner, pool.id)).toEqual([first.client]);
		core.userPools.deleteClient(owner, pool.id, first.client.id);
		expect(core.userPools.listClients(owner, pool.id)).toEqual([]);
	});

	test('discovery and JWKS are public, pool-scoped and never publish a private key', async () => {
		const owner = principal();
		const pool = await core.userPools.create(owner, { name: 'shop' });

		const discovery = await core.userPools.discovery(pool.id);
		expect(discovery.issuer).toBe(pool.issuer);
		expect(discovery.jwks_uri).toBe(`${pool.issuer}/.well-known/jwks.json`);
		expect(discovery.authorization_endpoint).toBe(`${pool.issuer}/oauth2/authorize`);
		expect(discovery.token_endpoint).toBe(`${pool.issuer}/oauth2/token`);
		expect(discovery.id_token_signing_alg_values_supported).toEqual(['ES256']);
		expect(discovery.code_challenge_methods_supported).toEqual(['S256']);
		expect(discovery.claims_supported).toContain('email');

		const jwks = await core.userPools.jwks(pool.id);
		expect(jwks.keys).toHaveLength(1);
		expect(jwks.keys[0]?.kid).toBe(pool.signingKeyId);
		expect(jwks.keys[0]).not.toHaveProperty('d');
		expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', use: 'sig', alg: 'ES256' });
	});

	test('a disabled pool stops answering discovery and JWKS', async () => {
		const owner = principal();
		const pool = await core.userPools.create(owner, { name: 'shop' });
		core.userPools.update(owner, pool.id, { disabled: true });

		await expect(core.userPools.discovery(pool.id)).rejects.toThrow(/not found/);
		await expect(core.userPools.jwks(pool.id)).rejects.toThrow(/not found/);
	});

	test('delete removes the pool and its clients', async () => {
		const owner = principal();
		const pool = await core.userPools.create(owner, { name: 'shop' });
		core.userPools.createClient(owner, pool.id, {
			name: 'web',
			redirectUris: ['https://shop.test/callback']
		});

		core.userPools.delete(owner, pool.id);
		expect(core.userPools.list(owner)).toEqual([]);
		expect(
			opened.sqlite
				.query<{ n: number }, [string]>(
					'SELECT COUNT(*) AS n FROM user_pool_clients WHERE pool_id = ?'
				)
				.get(pool.id)?.n
		).toBe(0);
	});

	test('permission checks cover create, read, update and credentials', async () => {
		const owner = principal();
		const pool = await core.userPools.create(owner, { name: 'shop' });
		const viewer = principal({ userId: 'user_viewer', role: 'viewer' });

		await expect(core.userPools.create(viewer, { name: 'other' })).rejects.toThrow(ForbiddenError);
		expect(() => core.userPools.get(viewer, pool.id)).toThrow(ForbiddenError);
		expect(() => core.userPools.list(viewer)).toThrow(ForbiddenError);
		expect(() =>
			core.userPools.createClient(viewer, pool.id, {
				name: 'web',
				redirectUris: ['https://shop.test/callback']
			})
		).toThrow(ForbiddenError);

		// A principal can hold read + update without the separate credentials permission.
		const limited: Principal = {
			...owner,
			kind: 'apiKey',
			keyId: 'key_pool_limited',
			permissions: new Set<Permission>(['userPool:read', 'userPool:update'])
		};
		expect(core.userPools.get(limited, pool.id)).toEqual(pool);
		expect(core.userPools.update(limited, pool.id, { description: 'Read and update' })).toMatchObject({
			description: 'Read and update'
		});
		expect(() =>
			core.userPools.createClient(limited, pool.id, {
				name: 'web',
				redirectUris: ['https://shop.test/callback']
			})
		).toThrow(ForbiddenError);
	});
});

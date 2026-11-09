import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	applyIdentityDesired,
	applyIdentitySecrets,
	exportIdentityKeyBundle,
	identityHealth,
	importIdentityKeyBundle,
} from '../src/state.ts';
import { identityDesiredSchema, identitySecretsSchema, identityKeyBundleSchema } from '@yoal/contracts';

/** The subset of the migrated identity schema these helpers touch. */
function identityDb(): Database {
	const sqlite = new Database(':memory:');
	sqlite.run(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
	sqlite.run(`CREATE TABLE identity_pools (
		pool_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, host TEXT NOT NULL, issuer TEXT NOT NULL,
		generation INTEGER NOT NULL, synced_at INTEGER NOT NULL
	)`);
	sqlite.run(`CREATE TABLE user_pools (
		id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
		engine TEXT NOT NULL, issuer TEXT NOT NULL, signing_key_id TEXT, signup_mode TEXT NOT NULL,
		theme_json TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL, disabled_at INTEGER
	)`);
	sqlite.run(`CREATE TABLE user_pool_clients (
		id TEXT PRIMARY KEY, pool_id TEXT NOT NULL, name TEXT NOT NULL, client_id TEXT NOT NULL,
		client_secret_sealed TEXT, redirect_uris_json TEXT NOT NULL DEFAULT '[]', public INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	)`);
	sqlite.run(`CREATE TABLE user_pool_oauth_providers (
		id TEXT PRIMARY KEY, pool_id TEXT NOT NULL, provider TEXT NOT NULL, client_id TEXT NOT NULL,
		client_secret_sealed TEXT NOT NULL, scopes_json TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL, UNIQUE (pool_id, provider)
	)`);
	sqlite.run(`CREATE TABLE signing_keys (
		kid TEXT PRIMARY KEY, alg TEXT NOT NULL, purpose TEXT NOT NULL, public_jwk TEXT NOT NULL,
		private_sealed TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, activated_at INTEGER,
		retire_after INTEGER
	)`);
	return sqlite;
}

function desired() {
	return identityDesiredSchema.parse({
		generation: 11,
		host: 'auth.example.com',
		upstream: '127.0.0.1:8788',
		pools: [
			{
				id: 'shop',
				orgId: 'org_1',
				host: 'auth.example.com',
				issuer: 'https://auth.example.com/shop',
				name: 'Shop',
				signupMode: 'open',
				clients: [
					{ id: 'upc_public', clientId: 'web', name: 'Web', public: true, redirectUris: ['https://shop.example.com/cb'] },
					{ id: 'upc_secret', clientId: 'server', name: 'Server', public: false, redirectUris: ['https://shop.example.com/cb'] },
				],
			},
		],
	});
}

describe('identity secret projection', () => {
	test('seals fetched secrets and never stores the plaintext', () => {
		const sqlite = identityDb();
		applyIdentityDesired(sqlite, desired());

		const bundle = identitySecretsSchema.parse({
			generation: 12,
			pools: [
				{
					id: 'shop',
					orgId: 'org_1',
					clients: [
						{ id: 'upc_public', clientId: 'web', secret: null },
						{ id: 'upc_secret', clientId: 'server', secret: 'client-secret-value' },
					],
					oauthProviders: [
						{
							provider: 'github',
							clientId: 'github-client',
							secret: 'github-secret-value',
							scopes: ['read:user'],
							enabled: true,
						},
					],
				},
			],
		});

		const sealed: string[] = [];
		applyIdentitySecrets(sqlite, (_orgId, value) => {
			const result = `sealed:${Buffer.from(value).toString('base64')}`;
			sealed.push(result);
			return result;
		}, bundle);

		const client = sqlite
			.query<{ client_secret_sealed: string | null }, [string]>(`SELECT client_secret_sealed FROM user_pool_clients WHERE id = ?`)
			.get('upc_secret')!;
		expect(client.client_secret_sealed).toBe(`sealed:${Buffer.from('client-secret-value').toString('base64')}`);
		expect(JSON.stringify(client)).not.toContain('client-secret-value');

		const provider = sqlite
			.query<{ client_secret_sealed: string; enabled: number; scopes_json: string }, []>(
				`SELECT client_secret_sealed, enabled, scopes_json FROM user_pool_oauth_providers`,
			)
			.get()!;
		expect(provider.client_secret_sealed).toContain('sealed:');
		expect(provider.enabled).toBe(1);
		expect(JSON.parse(provider.scopes_json)).toEqual(['read:user']);
		expect(
			sqlite.query<{ value: string }, []>(`SELECT value FROM settings WHERE key = 'identity.secrets_generation'`).get()?.value,
		).toBe('12');
		expect(sealed).toHaveLength(2);
	});

	test('a later desired-state push does not clear a sealed client secret', () => {
		const sqlite = identityDb();
		applyIdentityDesired(sqlite, desired());
		applyIdentitySecrets(sqlite, (_orgId, value) => `sealed:${value}`, identitySecretsSchema.parse({
			generation: 12,
			pools: [{ id: 'shop', orgId: 'org_1', clients: [{ id: 'upc_secret', clientId: 'server', secret: 'keep-me' }] }],
		}));
		applyIdentityDesired(sqlite, { ...desired(), generation: 13 });
		expect(
			sqlite.query<{ client_secret_sealed: string }, [string]>(`SELECT client_secret_sealed FROM user_pool_clients WHERE id = ?`).get('upc_secret')
				?.client_secret_sealed,
		).toBe('sealed:keep-me');
	});

	test('a secrets bundle replaces providers but keeps a public client working', () => {
		const sqlite = identityDb();
		applyIdentityDesired(sqlite, desired());
		applyIdentitySecrets(sqlite, (_orgId, value) => `sealed:${value}`, identitySecretsSchema.parse({
			generation: 1,
			pools: [{
				id: 'shop',
				orgId: 'org_1',
				oauthProviders: [{ provider: 'google', clientId: 'g', secret: 's', enabled: true }],
			}],
		}));
		applyIdentitySecrets(sqlite, (_orgId, value) => `sealed:${value}`, identitySecretsSchema.parse({
			generation: 2,
			pools: [{ id: 'shop', orgId: 'org_1', oauthProviders: [] }],
		}));
		expect(sqlite.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM user_pool_oauth_providers`).get()?.count).toBe(0);
		const publicClient = sqlite
			.query<{ client_secret_sealed: string | null; public: number }, [string]>(
				`SELECT client_secret_sealed, public FROM user_pool_clients WHERE id = ?`,
			)
			.get('upc_public')!;
		expect(publicClient.public).toBe(1);
		expect(publicClient.client_secret_sealed).toBeNull();
	});
});

describe('identity health and key continuity', () => {
	test('health reports pool count, state and secrets generations', () => {
		const sqlite = identityDb();
		applyIdentityDesired(sqlite, desired());
		applyIdentitySecrets(sqlite, (_orgId, value) => `sealed:${value}`, identitySecretsSchema.parse({
			generation: 12,
			pools: [{ id: 'shop', orgId: 'org_1' }],
		}));
		const health = identityHealth(sqlite, '1.2.3');
		expect(health).toMatchObject({ ok: true, ready: true, pools: 1, generation: 11, secretsGeneration: 12, version: '1.2.3' });
		expect(health.lastStateAt).toBeNumber();
	});

	test('exports a sealed bundle and imports it into another node', () => {
		const source = identityDb();
		applyIdentityDesired(source, desired());
		source.run(
			`INSERT INTO signing_keys (kid, alg, purpose, public_jwk, private_sealed, state, created_at, activated_at, retire_after)
			 VALUES ('kid_1', 'ES256', 'pool:shop', '{"kty":"EC"}', '{"nonce":"n","ciphertext":"c"}', 'active', 1, 1, NULL)`,
		);
		source.run(`UPDATE user_pools SET signing_key_id = 'kid_1' WHERE id = 'shop'`);
		const exported = exportIdentityKeyBundle(source);
		expect(exported.tooLarge).toBe(false);
		expect(exported.bundle.pools[0]?.keys[0]?.privateSealed).toContain('"ciphertext"');

		const destination = identityDb();
		applyIdentityDesired(destination, desired());
		expect(importIdentityKeyBundle(destination, identityKeyBundleSchema.parse(exported.bundle))).toBe(1);
		expect(
			destination.query<{ signing_key_id: string }, [string]>(`SELECT signing_key_id FROM user_pools WHERE id = ?`).get('shop')
				?.signing_key_id,
		).toBe('kid_1');
	});
});

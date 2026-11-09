import type { Database } from 'bun:sqlite';
import {
	identityKeyBundleSchema,
	type IdentityDesired,
	type IdentityHealth,
	type IdentityKeyBundle,
	type IdentitySecrets,
} from '@skiff/contracts';

/**
 * Materialise the agent-pushed projection into the identity database.
 *
 * `identity_pools` is the sync marker; `user_pools` and `user_pool_clients` are the tables the
 * existing `UserPoolService`/`UserPoolEngineService` read. Nothing here is secret: a client's
 * `client_secret_sealed` stays as it is (NULL until the authenticated secret fetch fills it), so a
 * confidential client fails closed until then. Public clients (PKCE) work unchanged.
 */
export function applyIdentityDesired(sqlite: Database, desired: IdentityDesired): void {
	const now = Date.now();
	const keyBundles: Array<{ bundle: IdentityKeyBundle; poolId: string }> = [];
	sqlite.transaction(() => {
		sqlite.run('DELETE FROM identity_pools');
		const keepPools = desired.pools.map((pool) => pool.id);
		const keepClients = desired.pools.flatMap((pool) => pool.clients.map((client) => client.id));

		for (const pool of desired.pools) {
			sqlite.run(
				`INSERT INTO identity_pools (pool_id, org_id, host, issuer, generation, synced_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[pool.id, pool.orgId, pool.host, pool.issuer, desired.generation, now],
			);
			sqlite.run(
				`INSERT INTO user_pools
				   (id, org_id, name, description, engine, issuer, signing_key_id, signup_mode,
				    theme_json, created_by, created_at, updated_at, disabled_at)
				 VALUES (?, ?, ?, '', 'skiff-identity', ?, NULL, ?, ?, 'identity', ?, ?, NULL)
				 ON CONFLICT(id) DO UPDATE SET
				   org_id = excluded.org_id,
				   name = excluded.name,
				   issuer = excluded.issuer,
				   signup_mode = excluded.signup_mode,
				   theme_json = excluded.theme_json,
				   updated_at = excluded.updated_at,
				   disabled_at = NULL`,
				[
					pool.id,
					pool.orgId,
					pool.name,
					pool.issuer,
					pool.signupMode,
					JSON.stringify(pool.theme),
					now,
					now,
				],
			);
			setSetting(sqlite, `user_pool.${pool.id}.require_email_verification`, pool.requireEmailVerification ? '1' : null);
			setSetting(sqlite, `user_pool.${pool.id}.mfa_required`, pool.mfaRequired ? '1' : null);

			for (const client of pool.clients) {
				sqlite.run(
					`INSERT INTO user_pool_clients
					   (id, pool_id, name, client_id, client_secret_sealed, redirect_uris_json, public, created_at)
					 VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET
					   pool_id = excluded.pool_id,
					   name = excluded.name,
					   client_id = excluded.client_id,
					   redirect_uris_json = excluded.redirect_uris_json,
					   public = excluded.public`,
					[client.id, pool.id, client.name, client.clientId, JSON.stringify(client.redirectUris), client.public ? 1 : 0, now],
				);
			}

			// A moved pool brings its sealed signing keys, so tokens minted before the move keep
			// verifying. This runs after the row upsert because the upsert resets `signing_key_id`.
			if (pool.keyBundle) {
				const bundle = decodeKeyBundle(pool.keyBundle);
				if (bundle) keyBundles.push({ bundle, poolId: pool.id });
			}
		}

		if (keepPools.length > 0) {
			const placeholders = keepPools.map(() => '?').join(', ');
			sqlite.run(`DELETE FROM user_pools WHERE id NOT IN (${placeholders})`, keepPools);
		} else {
			sqlite.run('DELETE FROM user_pools');
		}
		if (keepClients.length > 0) {
			const placeholders = keepClients.map(() => '?').join(', ');
			sqlite.run(`DELETE FROM user_pool_clients WHERE id NOT IN (${placeholders})`, keepClients);
		} else {
			sqlite.run('DELETE FROM user_pool_clients');
		}
		setSetting(sqlite, 'identity.generation', String(desired.generation));
		setSetting(sqlite, 'identity.last_state_at', String(now));
	})();
	// Import after the projection commits: a nested transaction is not portable across sqlite
	// drivers, and a bad bundle must not roll back the pool rows.
	for (const { bundle, poolId } of keyBundles) importIdentityKeyBundle(sqlite, bundle, new Set([poolId]));
}

/**
 * Seal and store the opened client/social secrets fetched over the node channel. The caller is the
 * identity process, so the plaintext exists only for the duration of this call and is never put in
 * a log, a setting or desired state. Rows that left the projection are left to `applyIdentityDesired`.
 */
export function applyIdentitySecrets(
	sqlite: Database,
	seal: (orgId: string, value: string) => string,
	secrets: IdentitySecrets,
): void {
	const now = Date.now();
	sqlite.transaction(() => {
		for (const pool of secrets.pools) {
			for (const client of pool.clients) {
				sqlite.run(
					`UPDATE user_pool_clients
					    SET client_secret_sealed = ?
					  WHERE id = ? AND pool_id = ?`,
					[client.secret === null ? null : seal(pool.orgId, client.secret), client.id, pool.id],
				);
			}

			const keepProviders = pool.oauthProviders.map((provider) => provider.provider);
			if (keepProviders.length > 0) {
				const placeholders = keepProviders.map(() => '?').join(', ');
				sqlite.run(
					`DELETE FROM user_pool_oauth_providers
					  WHERE pool_id = ? AND provider NOT IN (${placeholders})`,
					[pool.id, ...keepProviders],
				);
			} else {
				sqlite.run('DELETE FROM user_pool_oauth_providers WHERE pool_id = ?', [pool.id]);
			}
			for (const provider of pool.oauthProviders) {
				sqlite.run(
					`INSERT INTO user_pool_oauth_providers
					   (id, pool_id, provider, client_id, client_secret_sealed, scopes_json, enabled, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(pool_id, provider) DO UPDATE SET
					   client_id = excluded.client_id,
					   client_secret_sealed = excluded.client_secret_sealed,
					   scopes_json = excluded.scopes_json,
					   enabled = excluded.enabled`,
					[
						`upop_${pool.id}_${provider.provider}`,
						pool.id,
						provider.provider,
						provider.clientId,
						seal(pool.orgId, provider.secret),
						JSON.stringify(provider.scopes),
						provider.enabled ? 1 : 0,
						now,
					],
				);
			}
		}
		setSetting(sqlite, 'identity.secrets_generation', String(secrets.generation));
	})();
}

interface SigningKeyRow {
	kid: string;
	alg: string;
	purpose: string;
	public_jwk: string;
	private_sealed: string;
	state: 'next' | 'active' | 'retired';
	created_at: number;
	activated_at: number | null;
	retire_after: number | null;
}

/**
 * Export the sealed signing-key rows for the given pools (all when omitted). The private key stays
 * sealed with this process's master key the whole way, so the bundle never contains plaintext key
 * material. `tooLarge` is reported instead of returning a bundle that would bloat desired state.
 */
export function exportIdentityKeyBundle(
	sqlite: Database,
	poolIds?: readonly string[],
): { bundle: IdentityKeyBundle; bytes: number; tooLarge: boolean } {
	const pools = poolIds && poolIds.length > 0
		? sqlite
				.query<{ id: string; signing_key_id: string | null }, string[]>(
					`SELECT id, signing_key_id FROM user_pools WHERE id IN (${poolIds.map(() => '?').join(', ')}) ORDER BY name COLLATE NOCASE`,
				)
				.all(...poolIds)
		: sqlite
				.query<{ id: string; signing_key_id: string | null }, []>(
					'SELECT id, signing_key_id FROM user_pools ORDER BY name COLLATE NOCASE',
				)
				.all();
	const exportedAt = Date.now();
	const target = identityKeyBundleSchema.parse({
		version: 1,
		exportedAt,
		pools: pools.map((pool) => ({
			id: pool.id,
			signingKeyId: pool.signing_key_id,
			keys: sqlite
				.query<SigningKeyRow, [string]>(
					`SELECT kid, alg, purpose, public_jwk, private_sealed, state, created_at, activated_at, retire_after
					   FROM signing_keys WHERE purpose = ? ORDER BY created_at`,
				)
				.all(`pool:${pool.id}`)
				.map((key) => ({
					kid: key.kid,
					alg: key.alg,
					purpose: key.purpose,
					publicJwk: key.public_jwk,
					privateSealed: key.private_sealed,
					state: key.state,
					createdAt: key.created_at,
					activatedAt: key.activated_at,
					retireAfter: key.retire_after,
				})),
		})),
	});
	const bytes = Buffer.byteLength(JSON.stringify(target), 'utf8');
	return { bundle: target, bytes, tooLarge: bytes > 64 * 1024 };
}

/**
 * Import a sealed key bundle, optionally narrowed to the pools in `only`. Existing rows are
 * replaced, so importing the same bundle twice is idempotent. A destination node must share the
 * exporter's identity master key to open the sealed private JWKs.
 */
export function importIdentityKeyBundle(
	sqlite: Database,
	bundle: IdentityKeyBundle,
	only?: ReadonlySet<string>,
): number {
	let imported = 0;
	sqlite.transaction(() => {
		for (const pool of bundle.pools) {
			if (only && !only.has(pool.id)) continue;
			const existing = sqlite
				.query<{ id: string }, [string]>('SELECT id FROM user_pools WHERE id = ?')
				.get(pool.id);
			if (!existing) continue;
			for (const key of pool.keys) {
				sqlite.run(
					`INSERT INTO signing_keys
					   (kid, alg, purpose, public_jwk, private_sealed, state, created_at, activated_at, retire_after)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(kid) DO UPDATE SET
					   alg = excluded.alg,
					   public_jwk = excluded.public_jwk,
					   private_sealed = excluded.private_sealed,
					   state = excluded.state,
					   activated_at = excluded.activated_at,
					   retire_after = excluded.retire_after`,
					[
						key.kid,
						key.alg,
						key.purpose,
						key.publicJwk,
						key.privateSealed,
						key.state,
						key.createdAt,
						key.activatedAt,
						key.retireAfter,
					],
				);
				imported += 1;
			}
			if (pool.signingKeyId) {
				sqlite.run('UPDATE user_pools SET signing_key_id = ? WHERE id = ?', [pool.signingKeyId, pool.id]);
			}
		}
	})();
	return imported;
}

function decodeKeyBundle(value: string): IdentityKeyBundle | null {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
		const result = identityKeyBundleSchema.safeParse(parsed);
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}

export function identityHealth(sqlite: Database, version = 'dev'): IdentityHealth {
	const setting = (key: string): string | undefined =>
		sqlite.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(key)?.value;
	const generation = setting('identity.generation');
	const secretsGeneration = setting('identity.secrets_generation');
	const lastStateAt = setting('identity.last_state_at');
	const pools = sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM identity_pools').get()?.count ?? 0;
	return {
		ok: true,
		ready: true,
		status: 'running',
		generation: generation === undefined ? null : Number(generation),
		secretsGeneration: secretsGeneration === undefined ? null : Number(secretsGeneration),
		pools,
		version,
		lastStateAt: lastStateAt === undefined ? null : Number(lastStateAt),
	};
}

function setSetting(sqlite: Database, key: string, value: string | null): void {
	if (value === null) {
		sqlite.run('DELETE FROM settings WHERE key = ?', [key]);
		return;
	}
	sqlite.run(
		`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		[key, value, Date.now()],
	);
}

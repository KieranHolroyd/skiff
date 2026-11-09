import type { Database } from 'bun:sqlite';
import type { IdentityDesired, IdentityHealth } from '@skiff/contracts';

/**
 * Materialise the agent-pushed projection into the identity database.
 *
 * `identity_pools` is the sync marker; `user_pools` and `user_pool_clients` are the tables the
 * existing `UserPoolService`/`UserPoolEngineService` read. Nothing here is secret: a client's
 * `client_secret_sealed` stays NULL, so a confidential client fails closed until the per-node
 * secret fetch exists. Public clients (PKCE) work unchanged.
 */
export function applyIdentityDesired(sqlite: Database, desired: IdentityDesired): void {
	const now = Date.now();
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
	})();
}

export function identityHealth(sqlite: Database): IdentityHealth {
	const generation = sqlite
		.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
		.get('identity.generation')?.value;
	const pools = sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM identity_pools').get()?.count ?? 0;
	return {
		ok: true,
		generation: generation === undefined ? null : Number(generation),
		pools,
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

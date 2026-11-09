import {
	IDENTITY_DEFAULT_PORT,
	identityDesiredSchema,
	identityHost,
	type IdentityDesired,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { parseJson } from './util.ts';
import { userPoolMfaRequiredKey, userPoolRequireEmailVerificationKey } from './user-pools.ts';

/**
 * Builds the identity process's desired state from the control plane's pool rows (docs/IAM.md
 * §11.2). The projection is deliberately non-secret: client secrets stay sealed in `user_pools` on
 * the control plane and are fetched over an authenticated node channel in a later slice. Public
 * clients (PKCE) work with this projection as-is; a confidential client's token exchange fails
 * closed until that channel exists.
 */
export const IDENTITY_NODE_SETTING = 'identity.node_id';

interface PoolRow {
	id: string;
	org_id: string;
	name: string;
	issuer: string;
	signup_mode: string;
	theme_json: string;
	updated_at: number;
	disabled_at: number | null;
}

interface ClientRow {
	id: string;
	pool_id: string;
	name: string;
	client_id: string;
	redirect_uris_json: string;
	public: number;
}

/** A content hash keeps generation stable across pulls but changes whenever the projection does. */
export function identityGeneration(value: unknown): number {
	let hash = 0x811c9dc5;
	for (const char of JSON.stringify(value)) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
}

/** `DesiredState.identity`, only for the node selected to run `yoal-identity`. */
export function identityDesiredForNode(ctx: CoreContext, nodeId: string): IdentityDesired | null {
	const host = identityHost(ctx.config.contentDomain);
	if (!host) return null;
	const pools = ctx.sqlite
		.query<PoolRow, []>(
			`SELECT id, org_id, name, issuer, signup_mode, theme_json, updated_at, disabled_at
			   FROM user_pools
			  WHERE disabled_at IS NULL AND engine = 'yoal-identity'
			  ORDER BY name COLLATE NOCASE`,
		)
		.all();
	const clients = ctx.sqlite
		.query<ClientRow, []>(
			`SELECT id, pool_id, name, client_id, redirect_uris_json, public
			   FROM user_pool_clients
			  ORDER BY name COLLATE NOCASE`,
		)
		.all();
	const setting = (key: string): boolean =>
		ctx.sqlite.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(key)?.value === '1';
	const projection = {
		host,
		upstream: `127.0.0.1:${IDENTITY_DEFAULT_PORT}`,
		pools: pools.map((pool) => ({
			id: pool.id,
			orgId: pool.org_id,
			host,
			issuer: pool.issuer,
			name: pool.name,
			signupMode: pool.signup_mode === 'open' ? 'open' : 'invite',
			requireEmailVerification: setting(userPoolRequireEmailVerificationKey(pool.id)),
			mfaRequired: setting(userPoolMfaRequiredKey(pool.id)),
			theme: parseJson<Record<string, unknown>>(pool.theme_json, {}),
			clients: clients
				.filter((client) => client.pool_id === pool.id)
				.map((client) => ({
					id: client.id,
					clientId: client.client_id,
					name: client.name,
					public: client.public === 1,
					redirectUris: parseJson<string[]>(client.redirect_uris_json, []),
				})),
		})),
	};
	return identityDesiredSchema.parse({
		generation: identityGeneration({ nodeId, ...projection }),
		host: projection.host,
		upstream: projection.upstream,
		pools: projection.pools,
	});
}

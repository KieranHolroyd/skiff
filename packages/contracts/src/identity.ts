import * as z from 'zod';

/**
 * The separate user-pool identity process (docs/IAM.md §11.2, I27).
 *
 * A user pool's issuer is `https://auth.<sitesDomain>/<poolId>`. The control plane used to answer
 * that host through Caddy's platform fallback; `skiff-identity` is the target process, one per
 * install for now. This module carries the non-secret projection the identity database needs, the
 * authenticated per-node secret bundle the agent fetches separately, the node capability that
 * marks the process's host, and the key bundle that lets a pool move without invalidating tokens.
 *
 * Plaintext client/social secrets are never in desired state: the agent fetches them over the
 * node-token channel and relays them to the process on its private unix socket, where they are
 * sealed with the identity master key before being stored.
 */

export const IDENTITY_CAPABILITY = 'identity';
/** Fixed loopback port `skiff-identity` listens on for Caddy. */
export const IDENTITY_DEFAULT_PORT = 8788;
/** Fixed unix socket the node's agent uses to push state and read health. */
export const IDENTITY_DEFAULT_SOCKET = '/run/skiff/identity.sock';
/** A sealed key bundle larger than this is reported, not silently pushed through desired state. */
export const IDENTITY_KEY_BUNDLE_MAX_BYTES = 64 * 1024;

const poolIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const oauthProviderNames = ['google', 'github', 'microsoft', 'apple'] as const;

/** One OIDC client as the identity process needs it. `public` clients use PKCE and have no secret. */
export const identityPoolClientDesiredSchema = z
	.object({
		/** The control plane's row id. */
		id: z.string().min(1).max(128),
		clientId: z.string().min(1).max(200),
		name: z.string().min(1).max(200),
		public: z.boolean(),
		redirectUris: z.array(z.string().url()).max(50).default([]),
	})
	.strict();
export type IdentityPoolClientDesired = z.infer<typeof identityPoolClientDesiredSchema>;

/** One social provider's public configuration. Its client secret arrives in the secret bundle. */
export const identityOAuthProviderDesiredSchema = z
	.object({
		provider: z.enum(oauthProviderNames),
		clientId: z.string().min(1).max(512),
		scopes: z.array(z.string().min(1).max(100)).max(20).default([]),
		enabled: z.boolean().default(false),
	})
	.strict();
export type IdentityOAuthProviderDesired = z.infer<typeof identityOAuthProviderDesiredSchema>;

/**
 * One pool's projection. No password hashes, client secrets or signing keys: those live in the
 * identity process's own SQLite file and are never sent through desired state. `keyBundle` is an
 * optional already-sealed export (see `identityKeyBundleSchema`) used when moving a pool; the
 * process imports it before applying the pool rows so existing tokens keep verifying.
 */
export const identityPoolDesiredSchema = z
	.object({
		id: z.string().regex(poolIdPattern),
		orgId: z.string().min(1).max(100),
		host: z.string().min(1).max(253),
		issuer: z.string().url(),
		name: z.string().min(1).max(200),
		signupMode: z.enum(['open', 'invite']),
		requireEmailVerification: z.boolean().default(false),
		mfaRequired: z.boolean().default(false),
		/** Hosted-page theme, JSON only (no functions or credentials). */
		theme: z.record(z.string(), z.unknown()).default({}),
		clients: z.array(identityPoolClientDesiredSchema).default([]),
		/** Public social-provider configuration; the sealed secret is fetched separately. */
		oauthProviders: z.array(identityOAuthProviderDesiredSchema).max(10).default([]),
		/**
		 * Base64 JSON of `identityKeyBundleSchema`. Omitted when the control plane has nothing to
		 * move, and rejected above `IDENTITY_KEY_BUNDLE_MAX_BYTES` so desired state stays small.
		 */
		keyBundle: z.string().max(Math.ceil((IDENTITY_KEY_BUNDLE_MAX_BYTES * 4) / 3) + 4).optional(),
	})
	.strict();
export type IdentityPoolDesired = z.infer<typeof identityPoolDesiredSchema>;

/**
 * `DesiredState.identity`: present only on the node that runs `skiff-identity`. `generation` is a
 * content hash, so the agent re-pushes only when the projection changes. `upstream` is the Caddy
 * dial target and is not a secret.
 */
export const identityDesiredSchema = z
	.object({
		generation: z.number().int().nonnegative(),
		host: z.string().min(1).max(253),
		upstream: z.string().min(1).max(253),
		pools: z.array(identityPoolDesiredSchema).default([]),
	})
	.strict();
export type IdentityDesired = z.infer<typeof identityDesiredSchema>;

// ---------------------------------------------------------------- per-node secrets

/**
 * One client in the authenticated secret bundle. `secret` is the opened value and is only ever
 * present on the node-token channel; the process seals it before the row is written.
 */
export const identityClientSecretSchema = z
	.object({
		id: z.string().min(1).max(128),
		clientId: z.string().min(1).max(200),
		secret: z.string().max(8192).nullable(),
	})
	.strict();
export type IdentityClientSecret = z.infer<typeof identityClientSecretSchema>;

/** One social provider in the secret bundle. The public fields mirror the projection. */
export const identityOAuthProviderSecretSchema = z
	.object({
		provider: z.enum(oauthProviderNames),
		clientId: z.string().min(1).max(512),
		secret: z.string().min(1).max(8192),
		scopes: z.array(z.string().min(1).max(100)).max(20).default([]),
		enabled: z.boolean().default(false),
	})
	.strict();
export type IdentityOAuthProviderSecret = z.infer<typeof identityOAuthProviderSecretSchema>;

export const identityPoolSecretsSchema = z
	.object({
		id: z.string().regex(poolIdPattern),
		orgId: z.string().min(1).max(100),
		clients: z.array(identityClientSecretSchema).max(200).default([]),
		oauthProviders: z.array(identityOAuthProviderSecretSchema).max(10).default([]),
	})
	.strict();
export type IdentityPoolSecrets = z.infer<typeof identityPoolSecretsSchema>;

/**
 * `GET /api/agent/identity/secrets` (node-token authenticated). Never in desired state and never
 * logged: the agent forwards it straight to the process's unix socket.
 */
export const identitySecretsSchema = z
	.object({
		generation: z.number().int().nonnegative(),
		pools: z.array(identityPoolSecretsSchema).default([]),
	})
	.strict();
export type IdentitySecrets = z.infer<typeof identitySecretsSchema>;

// ---------------------------------------------------------------- key continuity

/**
 * The signing-key rows that keep pool tokens valid when a pool moves between identity nodes.
 * `privateSealed` is already sealed with the identity master key, so the bundle can be copied
 * without ever exposing a private key; the destination node must be configured with the same
 * `SKIFF_IDENTITY_MASTER_KEY` (or import while that file is shared).
 */
export const identityKeyBundleSchema = z
	.object({
		version: z.literal(1),
		exportedAt: z.number().int().nonnegative(),
		pools: z
			.array(
				z
					.object({
						id: z.string().regex(poolIdPattern),
						signingKeyId: z.string().max(200).nullable(),
						keys: z
							.array(
								z
									.object({
										kid: z.string().min(1).max(200),
										alg: z.string().min(1).max(40),
										purpose: z.string().min(1).max(200),
										publicJwk: z.string().min(1).max(16_384),
										privateSealed: z.string().min(1).max(32_768),
										state: z.enum(['next', 'active', 'retired']),
										createdAt: z.number().int().nonnegative(),
										activatedAt: z.number().int().nonnegative().nullable(),
										retireAfter: z.number().int().nonnegative().nullable(),
									})
									.strict(),
							)
							.max(20),
					})
					.strict(),
			)
			.max(1000),
	})
	.strict();
export type IdentityKeyBundle = z.infer<typeof identityKeyBundleSchema>;

/** What the process reports over its control socket. `ready` is the agent's readiness gate. */
export const identityHealthSchema = z
	.object({
		ok: z.literal(true),
		ready: z.boolean().default(true),
		status: z.enum(['starting', 'running', 'unhealthy']).default('running'),
		generation: z.number().int().nonnegative().nullable(),
		secretsGeneration: z.number().int().nonnegative().nullable().default(null),
		pools: z.number().int().nonnegative(),
		/** Process build, reported in the agent heartbeat. */
		version: z.string().max(80).default('dev'),
		/** Epoch milliseconds of the last applied projection, or null before the first push. */
		lastStateAt: z.number().int().nonnegative().nullable().default(null),
	})
	.strict();
export type IdentityHealth = z.infer<typeof identityHealthSchema>;

/** The heartbeat's view of the identity unit (optional; absent on non-identity nodes). */
export const identityUnitStatusSchema = z
	.object({
		status: z.enum(['starting', 'running', 'unhealthy', 'stopped']),
		version: z.string().max(80).nullable().default(null),
		generation: z.number().int().nonnegative().nullable().default(null),
		pools: z.number().int().nonnegative().default(0),
		restarts: z.number().int().nonnegative().default(0),
	})
	.strict();
export type IdentityUnitStatus = z.infer<typeof identityUnitStatusSchema>;

/**
 * One identity process per install. Prefer an operator-pinned node while it still advertises the
 * capability, then the edge, then any capable node in id order. Pure so placement can be tested.
 */
export function selectIdentityNode(
	capableNodeIds: readonly string[],
	configuredNodeId: string | null | undefined,
	edgeNodeId: string | null | undefined,
): string | null {
	const capable = [...new Set(capableNodeIds)].sort();
	if (capable.length === 0) return null;
	if (configuredNodeId && capable.includes(configuredNodeId)) return configuredNodeId;
	if (edgeNodeId && capable.includes(edgeNodeId)) return edgeNodeId;
	return capable[0] ?? null;
}

/** The public issuer host for a content domain (`auth.<sitesDomain>`). */
export function identityHost(contentDomain: string): string | null {
	const domain = contentDomain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
	if (!domain || domain.includes('..') || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain))
		return null;
	return `auth.${domain}`;
}

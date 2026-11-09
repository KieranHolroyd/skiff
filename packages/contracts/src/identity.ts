import * as z from 'zod';

/**
 * The separate user-pool identity process (docs/IAM.md §11.2, I27).
 *
 * A user pool's issuer is `https://auth.<sitesDomain>/<poolId>`. The control plane used to answer
 * that host through Caddy's platform fallback; `skiff-identity` is the target process, one per
 * install for now. This module only carries the non-secret projection the identity database needs
 * and the node capability that marks the process's host. Client secrets and signing keys never
 * appear here.
 */

export const IDENTITY_CAPABILITY = 'identity';
/** Fixed loopback port `skiff-identity` listens on for Caddy. */
export const IDENTITY_DEFAULT_PORT = 8788;
/** Fixed unix socket the node's agent uses to push state and read health. */
export const IDENTITY_DEFAULT_SOCKET = '/run/skiff/identity.sock';

const poolIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

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

/**
 * One pool's projection. No password hashes, client secrets or signing keys: those live in the
 * identity process's own SQLite file and are never sent through desired state.
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

/** What the identity process reports over its control socket. */
export const identityHealthSchema = z
	.object({
		ok: z.literal(true),
		generation: z.number().int().nonnegative().nullable(),
		pools: z.number().int().nonnegative(),
	})
	.strict();
export type IdentityHealth = z.infer<typeof identityHealthSchema>;

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

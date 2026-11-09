import * as z from 'zod';

/**
 * Workload identity (docs/IAM.md I18, §7.4).
 *
 * Every process or container workload runs as a service account. The control plane mints a
 * short-lived, audience-bound ES256 JWT for it, the agent delivers it through a rotated file, and
 * a node-local metadata endpoint mints tokens for other audiences on demand (for example
 * `sts.amazonaws.com`).
 *
 * The token is a credential: it never appears in desired state, logs or audit arguments. Only the
 * activation payload (fetched by the authenticated node) and the workload's own 0400 file carry it.
 */

/** The audience for Yoal's own API (IAM.md §7.4). */
export const WORKLOAD_IDENTITY_AUDIENCE = 'yoal';

/** Workload tokens are valid for one hour; the agent refreshes them at 50% of their lifetime. */
export const WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS = 60 * 60;

/** Heartbeat capability advertising token delivery and the metadata endpoint (docs/IAM.md I18). */
export const WORKLOAD_IDENTITY_CAPABILITY = 'workload-identity';

/** The environment variable naming the 0400 token file a workload reads. */
export const WORKLOAD_IDENTITY_TOKEN_ENV = 'YOAL_TOKEN_FILE';

/** The environment variable naming the node-local metadata endpoint, when one is available. */
export const WORKLOAD_IDENTITY_URL_ENV = 'YOAL_IDENTITY_URL';

/** The environment variables the control plane injects for workload identity. */
export type WorkloadIdentityEnvName = typeof WORKLOAD_IDENTITY_TOKEN_ENV | typeof WORKLOAD_IDENTITY_URL_ENV;

/** Where the workload sees its rotated token file. */
export const WORKLOAD_IDENTITY_MOUNT_PATH = '/var/run/yoal/token';

/** Root-owned host directory holding one directory and token file per workload. */
export const WORKLOAD_IDENTITY_HOST_DIR = '/run/yoal/identity';

/** Fixed loopback port for the agent's metadata endpoint (the analytics sink uses 8085). */
export const WORKLOAD_IDENTITY_PORT = 8086;

/**
 * Rootless Podman maps the host loopback through `host.containers.internal` (usually 10.0.2.2).
 * A process workload reaches the agent's own loopback address directly.
 */
export const WORKLOAD_IDENTITY_LOCAL_URL = `http://127.0.0.1:${WORKLOAD_IDENTITY_PORT}`;
export const WORKLOAD_IDENTITY_CONTAINER_URL = `http://host.containers.internal:${WORKLOAD_IDENTITY_PORT}`;

/** The host path of one workload's token: `/run/yoal/identity/<workload>/token`. */
export function workloadIdentityTokenPath(workloadId: string): string {
	return `${WORKLOAD_IDENTITY_HOST_DIR}/${workloadId}/token`;
}

/** The metadata URL a workload of this runtime uses, or null for a runtime with no identity. */
export function workloadIdentityUrl(runtime: 'process' | 'container' | 'function'): string | null {
	if (runtime === 'container') return WORKLOAD_IDENTITY_CONTAINER_URL;
	if (runtime === 'process') return WORKLOAD_IDENTITY_LOCAL_URL;
	return null;
}

/**
 * The claims Yoal's workload issuer sets. `sub` is the workload's service-account id; `act`
 * names the workload itself, so an audit row can tell which deployment used the token.
 */
export const workloadIdentityClaimSchema = z.object({
	iss: z.string(),
	sub: z.string(),
	aud: z.union([z.string(), z.array(z.string())]),
	iat: z.number().int(),
	exp: z.number().int(),
	org_id: z.string(),
	project_id: z.string(),
	environment: z.string(),
	act: z
		.object({
			sub: z.string(),
			/** The service account's name, for humans reading an audit trail. */
			name: z.string().optional(),
		})
		.optional(),
});
export type WorkloadIdentityClaim = z.infer<typeof workloadIdentityClaimSchema>;

/** The metadata endpoint's response, matching the OAuth 2.0 token response shape. */
export const workloadIdentityResponseSchema = z.object({
	access_token: z.string().min(1),
	expires_in: z.number().int().positive(),
	token_type: z.literal('Bearer'),
});
export type WorkloadIdentityResponse = z.infer<typeof workloadIdentityResponseSchema>;

/** The identity part of a workload activation. It is fetched, never cached in desired state. */
export const workloadIdentityActivationSchema = z.object({
	serviceAccount: z.string().min(1).max(40),
	serviceAccountId: z.string().min(1).max(100),
	audience: z.string().min(1).max(512),
	token: z.string().min(1).max(16_384),
	expiresIn: z.number().int().positive(),
});
export type WorkloadIdentityActivation = z.infer<typeof workloadIdentityActivationSchema>;

/** A service account name a workload spec may override (IAM.md §7.4). */
export const workloadIdentitySpecSchema = z.object({
	serviceAccount: z
		.string()
		.min(3)
		.max(40)
		.regex(
			/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/,
			'A service account name uses lowercase letters, digits and single hyphens.',
		),
});
export type WorkloadIdentitySpec = z.infer<typeof workloadIdentitySpecSchema>;

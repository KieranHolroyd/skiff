import * as z from 'zod';
import { SLUG_PATTERN } from './slugs.ts';

/**
 * Managed user pools (IAM.md I26–I29, §11.2).
 *
 * A pool is an org resource: a hosted OIDC provider for one deployed app's own end users. This
 * module owns the metadata and OIDC client shapes only. Users, passwords, sessions, MFA and the
 * hosted sign-in pages belong to the native `skiff-identity` engine (I27), which runs outside the
 * control plane; the dashboard deliberately does not fake any of them.
 *
 * The engine list is contract data, like database and broker engines (D95): `skiff-identity`
 * ships first, and a later Keycloak or Authentik entry is a registry change, not a migration.
 */

export const userPoolEngines = ['skiff-identity'] as const;
export type UserPoolEngineId = (typeof userPoolEngines)[number];

export const userPoolSignupModes = ['invite', 'open'] as const;
export type UserPoolSignupMode = (typeof userPoolSignupModes)[number];

/** A pool name is a slug, unique within the org. The issuer uses the id, so names can repeat. */
export const userPoolNameSchema = z
	.string()
	.trim()
	.toLowerCase()
	.min(2)
	.max(40)
	.regex(
		SLUG_PATTERN,
		'Use lowercase letters, digits and single hyphens; start and end with a letter or digit.',
	);

/** Hosted UI theme. Every field is optional; `{}` is the platform default. */
export const userPoolThemeSchema = z.object({
	logoUrl: z.string().trim().max(2048).optional(),
	displayName: z.string().trim().max(80).optional(),
	primaryColor: z
		.string()
		.regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex colour such as #4f46e5.')
		.optional(),
	backgroundColor: z
		.string()
		.regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex colour such as #ffffff.')
		.optional()
});
export type UserPoolTheme = z.infer<typeof userPoolThemeSchema>;

export const userPoolCreateSchema = z.object({
	name: userPoolNameSchema,
	description: z.string().trim().max(1000).optional(),
	engine: z.enum(userPoolEngines).default('skiff-identity'),
	signupMode: z.enum(userPoolSignupModes).default('invite'),
	theme: userPoolThemeSchema.optional()
});
export type UserPoolCreate = z.input<typeof userPoolCreateSchema>;

export const userPoolUpdateSchema = z.object({
	name: userPoolNameSchema.optional(),
	description: z.string().trim().max(1000).optional(),
	signupMode: z.enum(userPoolSignupModes).optional(),
	theme: userPoolThemeSchema.optional(),
	disabled: z.boolean().optional()
});
export type UserPoolUpdate = z.input<typeof userPoolUpdateSchema>;

/** Redirect URIs may be https URLs or a native app's custom scheme (RFC 8252). */
const redirectUriSchema = z
	.string()
	.trim()
	.min(1)
	.max(2048)
	.regex(
		/^[a-z][a-z0-9+.-]*:[^\s]+$/i,
		'Use an absolute redirect URI such as https://app.example.com/callback.'
	)
	.refine(
		(uri) => !/^(javascript|data|vbscript):/i.test(uri),
		'That redirect URI scheme is not allowed.'
	);

export const userPoolClientCreateSchema = z.object({
	name: z.string().trim().min(1).max(100),
	/** Exact allowlist; wildcards are deliberately not accepted. */
	redirectUris: z.array(redirectUriSchema).min(1).max(20),
	/** Public clients use PKCE and get no secret. */
	public: z.boolean().default(false)
});
export type UserPoolClientCreate = z.input<typeof userPoolClientCreateSchema>;

export interface UserPoolClientView {
	id: string;
	poolId: string;
	name: string;
	/** The OIDC `client_id` sent by the application. */
	clientId: string;
	redirectUris: readonly string[];
	public: boolean;
	createdAt: number;
}

/** A client's secret is returned exactly once, from creation; the view never carries it. */
export interface UserPoolClientCreated {
	client: UserPoolClientView;
	clientSecret: string | null;
}

/** The binding name a pool attachment exposes to a function (IAM.md I28, §11.2). */
export const USER_POOL_AUTH_BINDING = 'AUTH' as const;

/** Env names a pool attachment injects, under the prefix its owner chose (or the pool's name). */
export function userPoolEnvNames(prefix: string): string[] {
	return [`${prefix}_ISSUER`, `${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`];
}

/**
 * `shop` → `SHOP`, `acme-auth` → `ACME_AUTH`. The prefix must be a valid env name, so a pool
 * name that starts with a digit gets an `AUTH_` head rather than an illegal variable.
 */
export function userPoolDefaultEnvPrefix(name: string): string {
	const base = name
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 60);
	return /^[A-Z]/.test(base) ? base : `AUTH_${base}`.replace(/_+$/g, '');
}

/**
 * Attaching a pool to a project. The client must already exist and be confidential: an app gets
 * a real `<P>_CLIENT_SECRET`, and the same sealed row a database attachment uses delivers it at
 * activation. A public (PKCE-only) client has no secret to inject.
 */
export const userPoolAttachSchema = z.object({
	/** Pool name (a slug, unique within the org). */
	pool: userPoolNameSchema,
	/** Client name or public OIDC `client_id` in that pool. */
	client: z.string().trim().min(1).max(100),
	/** Injected env prefix; defaults to the pool name in UPPER_SNAKE. */
	envPrefix: z
		.string()
		.trim()
		.toUpperCase()
		.min(1)
		.max(64)
		.regex(/^[A-Z][A-Z0-9_]*$/, 'Use an env prefix such as SHOP or ACME_AUTH.')
		.optional()
});
export type UserPoolAttach = z.input<typeof userPoolAttachSchema>;

export interface UserPoolAttachmentView {
	id: string;
	orgId: string;
	poolId: string;
	poolName: string;
	issuer: string;
	/** The public OIDC `client_id` the app authenticates with. */
	clientId: string;
	clientName: string;
	projectId: string;
	projectSlug: string;
	envPrefix: string;
	/** Every env name the attachment injects, in a stable order. */
	envNames: string[];
	createdAt: string;
}

/** The public config a deployed app receives; never the client secret. */
export interface UserPoolAttachmentEnv {
	issuer: string;
	clientId: string;
}

export interface UserPoolView {
	id: string;
	orgId: string;
	name: string;
	description: string;
	engine: UserPoolEngineId;
	/** The public OIDC issuer, e.g. `https://auth.example.com/up_…`. */
	issuer: string;
	/** The active `pool:<id>` signing key's `kid`; null until discovery first creates the ring. */
	signingKeyId: string | null;
	signupMode: UserPoolSignupMode;
	theme: UserPoolTheme;
	disabled: boolean;
	disabledAt: number | null;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
}

/**
 * The minimal OIDC provider metadata a pool serves (OpenID Connect Discovery 1.0). No token or
 * userinfo requests are served until the identity engine ships; the document is published so
 * clients can be configured and the signing key is discoverable now.
 */
export interface UserPoolOidcDiscovery {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	userinfo_endpoint: string;
	jwks_uri: string;
	end_session_endpoint: string;
	response_types_supported: readonly string[];
	grant_types_supported: readonly string[];
	subject_types_supported: readonly string[];
	id_token_signing_alg_values_supported: readonly string[];
	scopes_supported: readonly string[];
	token_endpoint_auth_methods_supported: readonly string[];
	code_challenge_methods_supported: readonly string[];
	claims_supported: readonly string[];
}

/** The public half of a pool's signing key ring, never including a private `d`. */
export interface UserPoolJwks {
	keys: Array<Record<string, unknown>>;
}

/** Friendly aliases for consumers that speak the OIDC spec names. */
export type OidcDiscoveryDocument = UserPoolOidcDiscovery;
export type OidcJwks = UserPoolJwks;

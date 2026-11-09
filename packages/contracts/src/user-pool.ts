import * as z from 'zod';
import { SLUG_PATTERN } from './slugs.ts';

/**
 * Managed user pools (IAM.md I26–I29, §11.2).
 *
 * A pool is an org resource: a hosted OIDC provider for one deployed app's own end users. This
 * module owns the metadata and OIDC client shapes only. Users, passwords, sessions, MFA and the
 * hosted sign-in pages belong to the native `yoal-identity` engine (I27), which runs outside the
 * control plane; the dashboard deliberately does not fake any of them.
 *
 * The engine list is contract data, like database and broker engines (D95): `yoal-identity`
 * ships first, and a later Keycloak or Authentik entry is a registry change, not a migration.
 */

export const userPoolEngines = ['yoal-identity'] as const;
export type UserPoolEngineId = (typeof userPoolEngines)[number];

export const userPoolSignupModes = ['invite', 'open'] as const;
export type UserPoolSignupMode = (typeof userPoolSignupModes)[number];

/** Social identity providers a pool may offer on its hosted sign-in page (IAM.md §11.2). */
export const userPoolOAuthProviders = ['google', 'github', 'microsoft', 'apple'] as const;
export type UserPoolOAuthProvider = (typeof userPoolOAuthProviders)[number];

export const userPoolOAuthProviderLabels: Record<UserPoolOAuthProvider, string> = {
	google: 'Google',
	github: 'GitHub',
	microsoft: 'Microsoft',
	apple: 'Apple'
};

/**
 * Admin input for one provider. `clientSecret` is write-only: omit it to keep the sealed secret
 * already stored, send it to rotate. `scopes` replace the stored list; an empty list means the
 * provider's defaults. `enabled` controls whether the hosted page shows the button.
 */
export const userPoolOAuthProviderConfigSchema = z.object({
	clientId: z.string().trim().min(1).max(512),
	clientSecret: z.string().trim().min(1).max(8192).optional(),
	scopes: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
	enabled: z.boolean().optional()
});
export type UserPoolOAuthProviderConfig = z.input<typeof userPoolOAuthProviderConfigSchema>;

/**
 * One provider as Settings lists it. The client id is public (it travels in the authorization
 * URL); the secret never is, so `secretConfigured` is all a view says about it.
 */
export interface UserPoolOAuthProviderView {
	poolId: string;
	provider: UserPoolOAuthProvider;
	label: string;
	/** Empty until the provider is configured. */
	clientId: string;
	secretConfigured: boolean;
	scopes: string[];
	enabled: boolean;
	configured: boolean;
	/** The exact redirect URI to register with the provider, derived from the pool id. */
	callbackUrl: string;
	createdAt: number | null;
}

/** The public half of one enabled provider, for the hosted sign-in page. */
export interface UserPoolSocialProviderView {
	provider: UserPoolOAuthProvider;
	label: string;
}

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
	engine: z.enum(userPoolEngines).default('yoal-identity'),
	signupMode: z.enum(userPoolSignupModes).default('invite'),
	theme: userPoolThemeSchema.optional(),
	/**
	 * Refuse password sign-in until the address is verified. An `invite` pool always requires it
	 * (an invitation proves the address); an `open` pool only when this is set.
	 */
	requireEmailVerification: z.boolean().optional(),
	/** Advertise (and, for later slices, enforce) TOTP MFA for every pool user. */
	mfaRequired: z.boolean().optional(),
	/** Ask Have I Been Pwned (k-anonymity) before accepting a new password. */
	breachCheckEnabled: z.boolean().optional()
});
export type UserPoolCreate = z.input<typeof userPoolCreateSchema>;

export const userPoolUpdateSchema = z.object({
	name: userPoolNameSchema.optional(),
	description: z.string().trim().max(1000).optional(),
	signupMode: z.enum(userPoolSignupModes).optional(),
	theme: userPoolThemeSchema.optional(),
	requireEmailVerification: z.boolean().optional(),
	mfaRequired: z.boolean().optional(),
	breachCheckEnabled: z.boolean().optional(),
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
	/** Password sign-in waits for email verification. Always true for an invite-only pool. */
	requireEmailVerification: boolean;
	/** The pool asks every user to enrol TOTP MFA. Enrolment is per user and remains opt-in when false. */
	mfaRequired: boolean;
	/** New passwords are checked against Have I Been Pwned's k-anonymity range API. */
	breachCheckEnabled: boolean;
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

/**
 * One enrolled passkey, as the account page lists it. The credential id and public key never reach
 * the hosted page; removal targets the row id instead.
 */
export interface UserPoolPasskeyView {
	id: string;
	poolId: string;
	userId: string;
	name: string;
	createdAt: number;
	lastUsedAt: number | null;
}

/** A pool group, as the admin and claims surfaces list it. */
export interface UserPoolGroupView {
	id: string;
	poolId: string;
	name: string;
	createdAt: number;
	memberCount: number;
}

/** One member of a pool group; the email is convenient for the admin surface and never a claim. */
export interface UserPoolGroupMemberView {
	userId: string;
	email: string;
	name: string;
	addedAt: number;
}

/** Per-user TOTP state. The secret itself never appears in a view. */
export interface UserPoolTotpStatus {
	enabled: boolean;
	confirmedAt: number | null;
	/** How many unused recovery codes remain. */
	recoveryCodesRemaining: number;
}

/** The one-time enrolment response: secret and `otpauth://` URI, shown once. */
export interface UserPoolTotpEnrolment {
	secret: string;
	otpauthUri: string;
	/** The account label encoded in the URI, for copy. */
	account: string;
	issuer: string;
}

/** Recovery codes are shown exactly once, at confirmation or rotation. */
export interface UserPoolRecoveryCodes {
	recoveryCodes: string[];
}

/** A successful TOTP/recovery-code verification starts a pool session. */
export interface UserPoolMfaSignInResult {
	/** True when the code was a recovery code rather than a TOTP code. */
	usedRecoveryCode: boolean;
}

/** A credential descriptor the browser may suggest, used in the WebAuthn option documents. */
export interface UserPoolPasskeyCredentialDescriptor {
	id: string;
	type?: string;
	transports?: string[];
}

/**
 * The registration options document (`PublicKeyCredentialCreationOptions` in JSON form). It is
 * passed straight to `navigator.credentials.create()` after the client decodes the base64url
 * members, so the shape follows the WebAuthn JSON serialisation rather than the DOM types.
 */
export interface UserPoolPasskeyRegistrationOptionsJSON {
	challenge: string;
	rp: { id: string; name: string };
	user: { id: string; name: string; displayName: string };
	pubKeyCredParams: Array<{ alg: number; type: string }>;
	timeout?: number;
	attestation?: string;
	excludeCredentials?: UserPoolPasskeyCredentialDescriptor[];
	authenticatorSelection?: {
		authenticatorAttachment?: string;
		residentKey?: string;
		requireResidentKey?: boolean;
		userVerification?: string;
	};
	hints?: string[];
}

/** The authentication options document (`PublicKeyCredentialRequestOptions` in JSON form). */
export interface UserPoolPasskeyAuthenticationOptionsJSON {
	challenge: string;
	rpId: string;
	timeout?: number;
	allowCredentials?: UserPoolPasskeyCredentialDescriptor[];
	userVerification?: string;
	hints?: string[];
}

/**
 * A short-lived, one-time server-side challenge. The opaque `challengeId` is what the browser
 * echoes back; the WebAuthn `challenge` itself stays in `options`.
 */
export interface UserPoolPasskeyRegistrationChallenge {
	challengeId: string;
	expiresAt: number;
	options: UserPoolPasskeyRegistrationOptionsJSON;
}

export interface UserPoolPasskeyAuthenticationChallenge {
	challengeId: string;
	expiresAt: number;
	options: UserPoolPasskeyAuthenticationOptionsJSON;
}

// ---------------------------------------------------------------- import / export

/** Version of the pool JSON export. Import refuses a file from a newer major schema. */
export const USER_POOL_EXPORT_VERSION = 1;
export const USER_POOL_EXPORT_SCHEMA = 'yoal.user-pool';

/**
 * Algorithms the importer can keep usable. `bcrypt` and `argon2id` are verified by `Bun.password`;
 * `scrypt` is the platform's own portable wrapper (`scrypt$N$r$p$salt$hash`). Anything else forces
 * a password reset on the imported account.
 */
export const userPoolPasswordAlgorithms = ['argon2id', 'bcrypt', 'scrypt', 'none'] as const;
export type UserPoolPasswordAlgorithm = (typeof userPoolPasswordAlgorithms)[number];

/** Formats `POST /api/v1/user-pools/:id/import` accepts. `auto` sniffs the document. */
export const userPoolImportFormats = ['auto', 'yoal', 'auth0', 'cognito', 'firebase'] as const;
export type UserPoolImportFormatId = (typeof userPoolImportFormats)[number];
/** The concrete format a report names (never `auto`). */
export type UserPoolImportFormat = Exclude<UserPoolImportFormatId, 'auto'>;

/**
 * One user in a pool export. `passwordHash` is the encoded hash (argon2id/bcrypt/our scrypt
 * wrapper); it is a credential-equivalent and the endpoint requires `userPool:manage-users`.
 */
export interface UserPoolExportUser {
	id: string;
	email: string;
	name: string;
	emailVerified: boolean;
	disabled: boolean;
	passwordHash: string | null;
	passwordAlgorithm: UserPoolPasswordAlgorithm;
	/** The account cannot sign in with its password until a reset; set by an unsupported import. */
	mustResetPassword: boolean;
	metadata: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}

/** A group and its members, keyed by email so an export can be imported into another pool. */
export interface UserPoolExportGroup {
	id: string;
	name: string;
	createdAt: number;
	members: string[];
}

/**
 * An OIDC client. The sealed secret is never exported: a confidential client gets a fresh secret
 * exactly once when the export is imported.
 */
export interface UserPoolExportClient {
	id: string;
	name: string;
	clientId: string;
	redirectUris: string[];
	public: boolean;
	createdAt: number;
	/** Always null. Present so a reader can see that no secret is in the file. */
	clientSecret: null;
	secretHandling: 'regenerated-on-import';
}

/** A social provider's public configuration. The client secret is re-entered after an import. */
export interface UserPoolExportOAuthProvider {
	provider: UserPoolOAuthProvider;
	clientId: string;
	scopes: string[];
	enabled: boolean;
	createdAt: number;
	/** Always true. The sealed secret never leaves the instance. */
	secretOmitted: true;
}

/** Pool settings and theme, without the issuer/key ids that belong to one instance. */
export interface UserPoolExportMetadata {
	id: string;
	name: string;
	description: string;
	engine: UserPoolEngineId;
	signupMode: UserPoolSignupMode;
	requireEmailVerification: boolean;
	mfaRequired: boolean;
	breachCheckEnabled: boolean;
	theme: UserPoolTheme;
}

/** The versioned pool export document (`GET /api/v1/user-pools/:id/export`). */
export interface UserPoolExport {
	schema: typeof USER_POOL_EXPORT_SCHEMA;
	version: typeof USER_POOL_EXPORT_VERSION;
	exportedAt: string;
	pool: UserPoolExportMetadata;
	users: UserPoolExportUser[];
	groups: UserPoolExportGroup[];
	clients: UserPoolExportClient[];
	oauthProviders: UserPoolExportOAuthProvider[];
}

/** The request body for an import. `data` is the parsed export or provider document. */
export const userPoolImportSchema = z.object({
	format: z.enum(userPoolImportFormats).default('auto'),
	dryRun: z.boolean().default(false),
	data: z.unknown()
});
export type UserPoolImportRequest = z.input<typeof userPoolImportSchema>;

export interface UserPoolImportUserOutcome {
	email: string;
	action: 'create' | 'skip' | 'invalid';
	reason?: string;
	passwordAlgorithm: UserPoolPasswordAlgorithm;
	/** True when the stored hash is unusable and the account must set a new password. */
	mustResetPassword: boolean;
}

/**
 * What a dry run or an apply did. Counts are present in both; `clientSecrets` is returned exactly
 * once by an apply because every exported client secret is omitted.
 */
export interface UserPoolImportReport {
	format: UserPoolImportFormat;
	dryRun: boolean;
	users: {
		total: number;
		create: number;
		skip: number;
		invalid: number;
		mustResetPassword: number;
		unsupportedHashes: Array<{ email: string; algorithm: string; reason: string }>;
	};
	groups: { total: number; create: number; skip: number };
	clients: { total: number; create: number; skip: number };
	oauthProviders: { total: number; create: number; skip: number; needsSecret: number };
	outcomes: UserPoolImportUserOutcome[];
	/** Apply only: a fresh secret for each confidential client created by the import. */
	clientSecrets: Array<{ name: string; clientId: string; clientSecret: string }>;
}

/** Friendly aliases for consumers that speak the OIDC spec names. */
export type OidcDiscoveryDocument = UserPoolOidcDiscovery;
export type OidcJwks = UserPoolJwks;

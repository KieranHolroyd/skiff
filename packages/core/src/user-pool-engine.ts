/**
 * Native user-pool identity engine (IAM.md I10, I26–I28, §11.2).
 *
 * Email + password first, with the OIDC authorization-code flow a deployed app already expects.
 * `UserPoolService` keeps the pool/client lifecycle and public discovery/JWKS; this service owns
 * the pool's end users, sessions, authorization codes and hosted-page primitives. It deliberately
 * uses its own `user_pool_*` tables and `Bun.password` (argon2id), never Better Auth's platform
 * `user`/`session`/`account` tables, so a pool visitor is not a platform user and a platform
 * session cannot sign anybody into a pool.
 *
 * The wire format is the ordinary OIDC code flow:
 *
 *   authorize → code → token (PKCE / client secret) → userinfo, logout
 *
 * Codes are single-use, short lived and stored hashed. Tokens are signed by the pool's
 * `pool:<id>` ring key, so discovery's JWKS verifies them and the platform JWKS never publishes
 * them. The control-plane routes under `/api/v1/user-pools/:id/oauth/*` are thin adapters around
 * `authorize`, `token`, `userinfo` and `logout`.
 *
 * I28 is built around this engine: `UserPoolService` attaches a pool to a project and injects
 * `<P>_ISSUER`, `<P>_CLIENT_ID` and `<P>_CLIENT_SECRET` at activation, a function gets
 * `env.AUTH.verify(request)` against the pool JWKS, and `user.created`/`user.signed_in` are emitted
 * to the `pools` event source (D122). The secret stays in the sealed client row; only the
 * activation payload opens it.
 * Verification, magic-link sign-in, password reset and invitations leave through the same mail
 * path as platform mail: the transactional sender (`SKIFF_SMTP_*`, D22) when configured, else the
 * platform sender on the org's skiff-mail node, else a development-only link log. Links carry a
 * single-use token whose SHA-256 hash is all that is stored; no request reveals whether an address
 * is known, and each request is rate limited per address and per client IP.
 *
 * Passkeys are WebAuthn credentials bound to the pool issuer's host. Registration and sign-in use
 * a short-lived, one-time challenge that this process keeps server-side (the identity process will
 * move it to the pool's own SQLite file). Only the public key and signature counter are stored, a
 * counter that does not advance is refused as a cloned authenticator, and every failure is the
 * same generic refusal so neither an address nor a credential id becomes an enumeration oracle.
 *
 * TOTP MFA is RFC 6238 over a base32 secret sealed with the organisation key. The secret is never
 * stored in the clear, a confirmed enrolment is required before sign-in challenges for a code, the
 * last accepted step is a replay guard, and recovery codes are stored only as SHA-256 hashes and
 * shown once. Groups are the pool's own rows; their names travel as the `groups` claim.
 *
 * TODO(I27): social login, email OTP, breached-password checks, lockout, suspicious sign-in mail,
 * import/export and the identity process remain for a later slice.
 */
import { createRequire } from 'node:module';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
	UserPoolGroupMemberView,
	UserPoolGroupView,
	UserPoolPasskeyAuthenticationChallenge,
	UserPoolPasskeyAuthenticationOptionsJSON,
	UserPoolPasskeyRegistrationChallenge,
	UserPoolPasskeyRegistrationOptionsJSON,
	UserPoolPasskeyView,
	UserPoolRecoveryCodes,
	UserPoolTotpEnrolment,
	UserPoolTotpStatus
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import {
	ConflictError,
	CoreError,
	ForbiddenError,
	NotFoundError,
	RateLimitError,
	UnauthorizedError,
	ValidationError
} from './errors.ts';
import { newId, parseJson, randomToken, safeEqual, sha256Hex } from './util.ts';
import {
	userPoolMfaRequiredKey,
	userPoolRequireEmailVerificationKey,
	userPoolSigningPurpose
} from './user-pools.ts';

/** Session lifetime. Sliding expiry waits for the identity process (I27). */
export const USER_POOL_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Authorization codes are short lived, as OAuth requires. */
export const USER_POOL_CODE_TTL_SECONDS = 5 * 60;
/** Access and ID tokens; the signing ring's own maximum is one hour (keys.ts). */
export const USER_POOL_TOKEN_TTL_SECONDS = 60 * 60;
export const USER_POOL_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const USER_POOL_EMAIL_TOKEN_TTL_SECONDS = 24 * 60 * 60;
/** A magic link is short lived: it is a sign-in credential, not a receipt. */
export const USER_POOL_MAGIC_LINK_TTL_SECONDS = 15 * 60;
export const USER_POOL_PASSWORD_RESET_TTL_SECONDS = 60 * 60;
export const USER_POOL_PASSWORD_MIN_LENGTH = 8;
export const USER_POOL_PASSWORD_MAX_LENGTH = 200;

/** A WebAuthn challenge is a sign-in credential itself: short lived and single use. */
export const USER_POOL_PASSKEY_CHALLENGE_TTL_SECONDS = 5 * 60;
/** Per-user registration challenges in one rolling window. */
export const USER_POOL_PASSKEY_REGISTER_LIMIT = 10;
/** Sign-in options and verification attempts, per address/credential and per client IP. */
export const USER_POOL_PASSKEY_LOGIN_LIMIT = 20;
export const USER_POOL_PASSKEY_POOL_LIMIT = 200;
/** How many outstanding challenges one process will remember before it drops the oldest. */
export const USER_POOL_PASSKEY_CHALLENGE_CAP = 10_000;

/** Request throttles, per address and per client IP, over one rolling window. */
export const USER_POOL_REQUEST_WINDOW_SECONDS = 15 * 60;
export const USER_POOL_MAGIC_EMAIL_LIMIT = 5;
export const USER_POOL_RESET_EMAIL_LIMIT = 3;
export const USER_POOL_VERIFY_EMAIL_LIMIT = 3;
export const USER_POOL_REQUEST_IP_LIMIT = 20;

/** TOTP MFA: a pending sign-in is short lived, a code may be tried five times, and codes are 30s. */
export const USER_POOL_MFA_CHALLENGE_TTL_SECONDS = 5 * 60;
export const USER_POOL_MFA_MAX_ATTEMPTS = 5;
export const USER_POOL_TOTP_WINDOW_STEPS = 1;
export const USER_POOL_TOTP_PERIOD_SECONDS = 30;
export const USER_POOL_TOTP_DIGITS = 6;
export const USER_POOL_RECOVERY_CODE_COUNT = 10;
/** How many pending MFA challenges one process will remember before it drops the oldest. */
export const USER_POOL_MFA_CHALLENGE_CAP = 10_000;

/** The hosted page each kind of mail points at. */
export type UserPoolMailPurpose = 'verify_email' | 'magic_link' | 'password_reset' | 'invite';

/**
 * One transactional message for a pool's end user. `link` is the single-use URL; it is present so
 * the development fallback can print it, and must never be written to a production log.
 */
export interface UserPoolMailMessage {
	orgId: string;
	poolId: string;
	poolName: string;
	to: string;
	purpose: UserPoolMailPurpose;
	subject: string;
	text: string;
	link: string;
}

/** The mail seam `createCore` wires; tests inject a capture hook. */
export interface UserPoolMailer {
	send(message: UserPoolMailMessage): Promise<void>;
}

type EmailTokenPurpose = 'verify_email' | 'magic_link' | 'password_reset';

const EMAIL_TOKEN_TTL: Record<EmailTokenPurpose, number> = {
	verify_email: USER_POOL_EMAIL_TOKEN_TTL_SECONDS,
	magic_link: USER_POOL_MAGIC_LINK_TTL_SECONDS,
	password_reset: USER_POOL_PASSWORD_RESET_TTL_SECONDS
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUPPORTED_SCOPES = new Set(['openid', 'profile', 'email']);

export interface UserPoolUserView {
	id: string;
	poolId: string;
	email: string;
	name: string;
	emailVerified: boolean;
	disabled: boolean;
	metadata: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}

export interface UserPoolSessionView {
	id: string;
	poolId: string;
	userId: string;
	expiresAt: number;
	createdAt: number;
	lastSeenAt: number | null;
	revokedAt: number | null;
}

export interface UserPoolSessionContext {
	user: UserPoolUserView;
	session: UserPoolSessionView;
}

export interface UserPoolSignUpResult {
	user: UserPoolUserView;
	/** Raw verification token; null when the invite already proved the address. */
	verificationToken: string | null;
}

export interface UserPoolInviteView {
	id: string;
	poolId: string;
	email: string;
	createdBy: string | null;
	createdAt: number;
	expiresAt: number;
	usedAt: number | null;
}

export interface UserPoolInviteCreated {
	invite: UserPoolInviteView;
	/** Returned exactly once; only its SHA-256 hash is stored. */
	token: string;
}

export interface UserPoolSignInResult extends UserPoolSessionContext {
	/** Raw opaque session token; only its SHA-256 hash is stored. */
	token: string;
	/** Open pools allow an unverified address; the hosted page should offer to resend the link. */
	emailVerificationPending: boolean;
	/**
	 * True when the password was right but a TOTP/recovery code is still required. In that case
	 * `token` is a short-lived MFA challenge token, not a session: `session()` refuses it and the
	 * hosted page must call `totpVerify` before setting the session cookie.
	 */
	mfaRequired: boolean;
	/** Opaque MFA challenge token, present only when `mfaRequired` is true. */
	mfaToken?: string;
	/** When the MFA challenge expires, present only when `mfaRequired` is true. */
	mfaExpiresAt?: number;
}

export interface UserPoolAuthorizeInput {
	poolId: string;
	clientId: string;
	redirectUri: string;
	responseType: string;
	scope?: string | null;
	state?: string | null;
	nonce?: string | null;
	codeChallenge?: string | null;
	codeChallengeMethod?: string | null;
	/** The caller's pool-session cookie, when the browser already signed in. */
	sessionToken?: string | null;
	/** The full authorize URL, used to return to this request after hosted sign-in. */
	requestUrl?: string | null;
}

export interface UserPoolAuthorizeResult {
	/** Always an absolute or root-relative redirect target. */
	redirect: string;
	/** True when the redirect is the hosted login page rather than the client's callback. */
	needsLogin: boolean;
}

export interface UserPoolTokenInput {
	poolId: string;
	grantType: string;
	clientId: string;
	clientSecret?: string | null;
	code?: string | null;
	redirectUri?: string | null;
	codeVerifier?: string | null;
}

export interface UserPoolTokenResult {
	access_token: string;
	token_type: 'Bearer';
	expires_in: number;
	id_token: string;
	scope: string;
}

export interface UserPoolUserInfo {
	sub: string;
	email?: string;
	email_verified?: boolean;
	name?: string;
	/** Pool group names, straight from the engine's own group tables. */
	groups?: string[];
}

/**
 * The WebAuthn registration response as `@simplewebauthn/browser` serialises it. Binary members
 * are base64url strings, which is what the server library expects.
 */
export interface UserPoolPasskeyRegistrationResponse {
	id: string;
	rawId: string;
	type: string;
	response: {
		clientDataJSON: string;
		attestationObject: string;
		transports?: string[];
	};
	clientExtensionResults?: Record<string, unknown>;
	authenticatorAttachment?: string | null;
}

/** The assertion response, again in the browser library's JSON form. */
export interface UserPoolPasskeyAuthenticationResponse {
	id: string;
	rawId: string;
	type: string;
	response: {
		clientDataJSON: string;
		authenticatorData: string;
		signature: string;
		userHandle?: string | null;
	};
	clientExtensionResults?: Record<string, unknown>;
	authenticatorAttachment?: string | null;
}

/** A credential as `verifyAuthenticationResponse` needs it: public key bytes and the counter. */
export interface UserPoolWebAuthnCredential {
	id: string;
	publicKey: Uint8Array;
	counter: number;
	transports?: string[];
}

export interface UserPoolWebAuthnRegistrationResult {
	verified: boolean;
	registrationInfo?: {
		credential: UserPoolWebAuthnCredential;
	};
}

export interface UserPoolWebAuthnAuthenticationResult {
	verified: boolean;
	authenticationInfo?: {
		newCounter: number;
	};
}

export interface UserPoolRegistrationOptionsInput {
	rpName: string;
	rpID: string;
	userName: string;
	userID: Uint8Array;
	userDisplayName?: string;
	attestationType?: 'none';
	excludeCredentials?: Array<{ id: string; transports?: string[] }>;
	authenticatorSelection?: {
		residentKey?: 'required' | 'preferred' | 'discouraged';
		userVerification?: 'required' | 'preferred' | 'discouraged';
	};
}

export interface UserPoolRegistrationVerifyInput {
	response: UserPoolPasskeyRegistrationResponse;
	expectedChallenge: string;
	expectedOrigin: string;
	expectedRPID: string;
	requireUserVerification: boolean;
}

export interface UserPoolAuthenticationOptionsInput {
	rpID: string;
	allowCredentials?: Array<{ id: string; transports?: string[] }>;
	userVerification: 'required' | 'preferred' | 'discouraged';
}

export interface UserPoolAuthenticationVerifyInput {
	response: UserPoolPasskeyAuthenticationResponse;
	expectedChallenge: string;
	expectedOrigin: string;
	expectedRPID: string;
	credential: UserPoolWebAuthnCredential;
	requireUserVerification: boolean;
}

/**
 * The four WebAuthn operations the engine needs, narrowed to the fields it uses. The real
 * implementation is `@simplewebauthn/server`; tests inject a fake through
 * `setUserPoolWebAuthnProvider`, and a deployment without the package fails with a clear 503.
 */
export interface UserPoolWebAuthnProvider {
	generateRegistrationOptions(
		options: UserPoolRegistrationOptionsInput
	): Promise<UserPoolPasskeyRegistrationOptionsJSON>;
	verifyRegistrationResponse(
		options: UserPoolRegistrationVerifyInput
	): Promise<UserPoolWebAuthnRegistrationResult>;
	generateAuthenticationOptions(
		options: UserPoolAuthenticationOptionsInput
	): Promise<UserPoolPasskeyAuthenticationOptionsJSON>;
	verifyAuthenticationResponse(
		options: UserPoolAuthenticationVerifyInput
	): Promise<UserPoolWebAuthnAuthenticationResult>;
}

export interface UserPoolPasskeyRegisterVerifyInput {
	poolId: string;
	userId: string;
	challengeId: string;
	response: UserPoolPasskeyRegistrationResponse;
	name?: string | null;
}

export interface UserPoolPasskeyLoginVerifyInput {
	poolId: string;
	challengeId: string;
	response: UserPoolPasskeyAuthenticationResponse;
	/** Optional hint; never used to shape the options, only to reject a mismatched credential. */
	email?: string | null;
	ip?: string | null;
}

interface UserPoolPasskeyRow {
	id: string;
	pool_id: string;
	user_id: string;
	credential_id: string;
	public_key: string;
	counter: number;
	transports_json: string;
	name: string;
	created_at: number;
	last_used_at: number | null;
}

interface PasskeyChallengeRecord {
	poolId: string;
	type: 'registration' | 'authentication';
	userId: string | null;
	emailHint: string | null;
	challenge: string;
	rpId: string;
	origin: string;
	expiresAt: number;
}

interface UserPoolRow {
	id: string;
	org_id: string;
	name: string;
	issuer: string;
	signup_mode: string;
	theme_json: string;
	disabled_at: number | null;
}

interface ClientRow {
	id: string;
	pool_id: string;
	client_id: string;
	client_secret_sealed: string | null;
	redirect_uris_json: string;
	public: number;
}

interface UserRow {
	id: string;
	pool_id: string;
	email: string;
	email_verified_at: number | null;
	password_hash: string;
	name: string;
	metadata_json: string;
	created_at: number;
	updated_at: number;
	disabled_at: number | null;
}

interface SessionRow {
	id: string;
	pool_id: string;
	user_id: string;
	expires_at: number;
	created_at: number;
	last_seen_at: number | null;
	revoked_at: number | null;
}

interface CodeRow {
	code_hash: string;
	pool_id: string;
	client_id: string;
	user_id: string;
	redirect_uri: string;
	scope: string;
	nonce: string | null;
	code_challenge: string | null;
	code_challenge_method: string | null;
	expires_at: number;
	used_at: number | null;
	created_at: number;
}

interface InviteRow {
	id: string;
	pool_id: string;
	email: string;
	token_hash: string;
	created_by: string | null;
	created_at: number;
	expires_at: number;
	used_at: number | null;
}

interface EmailTokenRow {
	token_hash: string;
	pool_id: string;
	user_id: string;
	purpose: string;
	created_at: number;
	expires_at: number;
	used_at: number | null;
}

interface UserPoolTotpRow {
	user_id: string;
	pool_id: string;
	secret_sealed: string;
	confirmed_at: number | null;
	last_step: number | null;
	recovery_codes_json: string;
	created_at: number;
}

interface RecoveryCodeEntry {
	hash: string;
	usedAt: number | null;
}

interface UserPoolGroupRow {
	id: string;
	pool_id: string;
	name: string;
	created_at: number;
	member_count: number;
}

interface UserPoolGroupMemberRow {
	user_id: string;
	email: string;
	name: string;
	created_at: number;
}

interface MfaChallengeRecord {
	poolId: string;
	userId: string;
	expiresAt: number;
	attempts: number;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 as RFC 4648 defines it, unpadded: the form authenticator apps import. */
export function base32Encode(bytes: Uint8Array): string {
	let bits = '';
	for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
	let out = '';
	for (let index = 0; index + 5 <= bits.length; index += 5)
		out += BASE32_ALPHABET[Number.parseInt(bits.slice(index, index + 5), 2)];
	const remainder = bits.length % 5;
	if (remainder > 0)
		out += BASE32_ALPHABET[Number.parseInt(bits.slice(bits.length - remainder).padEnd(5, '0'), 2)];
	return out;
}

/** Decode an unpadded, case-insensitive base32 secret. Invalid characters are skipped, as in step-up. */
export function base32Decode(secret: string): Buffer {
	const encoded = secret.replace(/=+$/, '').toUpperCase();
	let bits = '';
	for (const char of encoded) {
		const index = BASE32_ALPHABET.indexOf(char);
		if (index < 0) continue;
		bits += index.toString(2).padStart(5, '0');
	}
	const bytes: number[] = [];
	for (let index = 0; index + 8 <= bits.length; index += 8)
		bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
	return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number, digits = USER_POOL_TOTP_DIGITS): string {
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(BigInt(counter));
	const digest = createHmac('sha1', secret).update(message).digest();
	const offset = digest[digest.length - 1]! & 0x0f;
	const value =
		((digest[offset]! & 0x7f) << 24) |
		((digest[offset + 1]! & 0xff) << 16) |
		((digest[offset + 2]! & 0xff) << 8) |
		(digest[offset + 3]! & 0xff);
	return String(value % 10 ** digits).padStart(digits, '0');
}

/**
 * Verify a six-digit code and return its RFC 6238 step, or null. One step each way tolerates clock
 * drift; every candidate is compared in constant time, and the six-digit shape is checked first.
 */
export function verifyUserPoolTotp(
	secret: string,
	code: string,
	now = Date.now(),
	options: { window?: number; periodSeconds?: number; digits?: number } = {}
): number | null {
	const normalized = code.replace(/[\s-]/g, '');
	if (!/^\d{6}$/.test(normalized)) return null;
	const bytes = base32Decode(secret);
	if (bytes.length === 0) return null;
	const period = options.periodSeconds ?? USER_POOL_TOTP_PERIOD_SECONDS;
	const current = Math.floor(now / 1000 / period);
	const window = options.window ?? USER_POOL_TOTP_WINDOW_STEPS;
	let matched: number | null = null;
	for (let offset = -window; offset <= window; offset += 1) {
		const expected = Buffer.from(hotp(bytes, current + offset, options.digits ?? USER_POOL_TOTP_DIGITS));
		const actual = Buffer.from(normalized);
		if (expected.length === actual.length && timingSafeEqual(expected, actual) && matched === null)
			matched = current + offset;
	}
	return matched;
}

function normalizeRecoveryCode(code: string): string {
	return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function recoveryCodeHash(code: string): string {
	return sha256Hex(`skiff-pool-recovery:${normalizeRecoveryCode(code)}`);
}

function parseRecoveryCodes(json: string): RecoveryCodeEntry[] {
	const value = parseJson<unknown>(json, []);
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!entry || typeof entry !== 'object') return [];
		const candidate = entry as { hash?: unknown; usedAt?: unknown };
		if (typeof candidate.hash !== 'string') return [];
		return [
			{
				hash: candidate.hash,
				usedAt: typeof candidate.usedAt === 'number' ? candidate.usedAt : null
			}
		];
	});
}

function groupView(row: UserPoolGroupRow): UserPoolGroupView {
	return {
		id: row.id,
		poolId: row.pool_id,
		name: row.name,
		createdAt: row.created_at,
		memberCount: row.member_count
	};
}

function groupMemberView(row: UserPoolGroupMemberRow): UserPoolGroupMemberView {
	return {
		userId: row.user_id,
		email: row.email,
		name: row.name,
		addedAt: row.created_at
	};
}

/** The pool-hosted session cookie name. Per pool, so two pools on one origin cannot mix sessions. */
export function userPoolSessionCookieName(poolId: string): string {
	return `skiff_pool_session_${poolId}`;
}

/** The double-submit CSRF cookie used by the hosted pages. */
export function userPoolCsrfCookieName(poolId: string): string {
	return `skiff_pool_csrf_${poolId}`;
}

function normalizeEmail(raw: string): string {
	const email = raw.trim().toLowerCase();
	if (!email || email.length > 320 || !EMAIL_PATTERN.test(email))
		throw new ValidationError('Enter a valid email address.');
	return email;
}

function validatePassword(password: string): void {
	if (password.length < USER_POOL_PASSWORD_MIN_LENGTH)
		throw new ValidationError(`Passwords must be at least ${USER_POOL_PASSWORD_MIN_LENGTH} characters.`);
	if (password.length > USER_POOL_PASSWORD_MAX_LENGTH)
		throw new ValidationError(`Passwords must be at most ${USER_POOL_PASSWORD_MAX_LENGTH} characters.`);
}

function validateGroupName(raw: string): string {
	const name = raw.trim();
	if (!name) throw new ValidationError('Give the group a name.');
	if (name.length > 80) throw new ValidationError('Group names are at most 80 characters.');
	return name;
}

/** Ten codes in `XXXX-XXXX` base32; the hyphens are presentation only and the hash strips them. */
function generateRecoveryCodes(count = USER_POOL_RECOVERY_CODE_COUNT): string[] {
	return Array.from({ length: count }, () => {
		const encoded = base32Encode(randomBytes(5));
		return `${encoded.slice(0, 4)}-${encoded.slice(4)}`;
	});
}

function sha256Base64Url(value: string): string {
	return createHash('sha256').update(value).digest('base64url');
}

function appendQuery(uri: string, values: Record<string, string | null | undefined>): string {
	const url = new URL(uri);
	for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined) url.searchParams.set(key, value);
	return url.toString();
}

function parseScopes(raw: string | null | undefined): string[] | null {
	const scope = (raw ?? '').trim();
	if (!scope) return ['openid'];
	const scopes = scope.split(/\s+/).filter(Boolean);
	if (!scopes.includes('openid') || scopes.some((value) => !SUPPORTED_SCOPES.has(value))) return null;
	return [...new Set(scopes)];
}

/** The WebAuthn relying party a pool uses. Derived from the pool issuer unless a page origin is given. */
export interface UserPoolPasskeyRelyingParty {
	/** The `rpID`: a hostname, never a URL. */
	rpId: string;
	/** The exact page origin the browser will report at verification time. */
	origin: string;
}

function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host === '127.0.0.1' ||
		host === '::1' ||
		host === '[::1]'
	);
}

/** Whether two hostnames belong to the same site (a conservative suffix test, not a PSL lookup). */
function sameSiteHost(left: string, right: string): boolean {
	const a = left.toLowerCase();
	const b = right.toLowerCase();
	if (a === b) return true;
	if (a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
	const aParts = a.split('.');
	const bParts = b.split('.');
	return aParts.length >= 2 && bParts.length >= 2 && aParts.slice(-2).join('.') === bParts.slice(-2).join('.');
}

/**
 * Resolve the pool's relying party. Without a request origin the issuer's host is used verbatim
 * (`https://auth.example.com/<pool>` → `auth.example.com`). The hosted pages also run on the
 * control-plane origin; when a page origin is supplied it must be the issuer host or share its
 * site, so a page on an unrelated host can never register a credential for this pool.
 */
export function userPoolPasskeyRelyingParty(
	issuer: string,
	requestOrigin?: string | null
): UserPoolPasskeyRelyingParty {
	let issuerUrl: URL;
	try {
		issuerUrl = new URL(issuer);
	} catch {
		throw new ValidationError('This user pool has an invalid issuer.');
	}
	const fallback = { rpId: issuerUrl.hostname, origin: issuerUrl.origin };
	if (!requestOrigin) return fallback;

	let requestUrl: URL;
	try {
		requestUrl = new URL(requestOrigin);
	} catch {
		throw new ValidationError('That passkey request origin is not valid.');
	}
	if (requestUrl.protocol !== 'https:' && !(requestUrl.protocol === 'http:' && isLoopbackHost(requestUrl.hostname)))
		throw new ValidationError('Passkeys need HTTPS (or localhost).');
	if (!sameSiteHost(requestUrl.hostname, issuerUrl.hostname))
		throw new ValidationError('That passkey request belongs to another site.');
	return { rpId: requestUrl.hostname, origin: requestUrl.origin };
}

/**
 * Whether an assertion's signature counter proves it is fresh. A stored zero means the
 * authenticator does not implement a counter, so any non-negative value is accepted; otherwise the
 * counter must strictly increase, or the credential may have been cloned.
 */
export function passkeyCounterAccepted(stored: number, next: number): boolean {
	if (!Number.isFinite(next) || next < 0) return false;
	return stored === 0 ? true : next > stored;
}

let injectedWebAuthn: UserPoolWebAuthnProvider | null | undefined;

/** Replace the WebAuthn implementation (tests), or pass null to restore the lazy default loader. */
export function setUserPoolWebAuthnProvider(provider: UserPoolWebAuthnProvider | null): void {
	injectedWebAuthn = provider;
}

function webAuthnAnchors(): string[] {
	const anchors: string[] = [import.meta.url];
	const add = (path: string | undefined): void => {
		if (!path) return;
		try {
			anchors.push(pathToFileURL(path).href);
		} catch {
			// An anchor that cannot be a file URL is simply skipped.
		}
	};
	add(join(process.cwd(), 'package.json'));
	add(join(process.cwd(), 'apps/control-plane/package.json'));
	try {
		add(join(import.meta.dir, '../../../apps/control-plane/package.json'));
	} catch {
		// `import.meta.dir` is Bun-specific; a bundled build may not have it.
	}
	add(process.argv[1]);
	return anchors;
}

function resolveFromAnchors(specifier: string, anchors: string[]): string | null {
	for (const anchor of anchors) {
		try {
			return createRequire(anchor).resolve(specifier);
		} catch {
			// Try the next anchor.
		}
	}
	return null;
}

/**
 * `@simplewebauthn/server` arrives through the platform's passkey plugin, not as a direct
 * dependency of this package (the same reason `step-up/webauthn.ts` resolves it that way). Search
 * the process's workspace roots so an in-process control plane and a bundled build both find it.
 */
function loadWebAuthnProvider(): UserPoolWebAuthnProvider {
	const anchors = webAuthnAnchors();
	let entry = resolveFromAnchors('@simplewebauthn/server', anchors);
	if (!entry) {
		const passkey = resolveFromAnchors('@better-auth/passkey', anchors);
		if (passkey) entry = resolveFromAnchors('@simplewebauthn/server', [passkey]);
	}
	if (!entry)
		throw new CoreError('passkey_unavailable', 'Passkeys are not available on this server.', 503);
	const loaded = createRequire(entry)(entry) as unknown;
	if (!loaded || typeof loaded !== 'object')
		throw new CoreError('passkey_unavailable', 'Passkeys are not available on this server.', 503);
	const candidate = loaded as Partial<UserPoolWebAuthnProvider>;
	for (const name of [
		'generateRegistrationOptions',
		'verifyRegistrationResponse',
		'generateAuthenticationOptions',
		'verifyAuthenticationResponse'
	] as const) {
		if (typeof candidate[name] !== 'function')
			throw new CoreError('passkey_unavailable', 'Passkeys are not available on this server.', 503);
	}
	return candidate as UserPoolWebAuthnProvider;
}

function webAuthnProvider(): UserPoolWebAuthnProvider {
	if (!injectedWebAuthn) injectedWebAuthn = loadWebAuthnProvider();
	return injectedWebAuthn;
}

function parseTransports(json: string): string[] {
	const value = parseJson<unknown>(json, []);
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function passkeyView(row: UserPoolPasskeyRow): UserPoolPasskeyView {
	return {
		id: row.id,
		poolId: row.pool_id,
		userId: row.user_id,
		name: row.name,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at
	};
}

function passkeyName(raw: string | null | undefined, transports: string[]): string {
	const name = (raw ?? '').trim().slice(0, 80);
	if (name) return name;
	if (transports.includes('hybrid')) return 'Phone or tablet';
	if (transports.includes('internal')) return 'This device';
	return 'Passkey';
}

export class UserPoolEngineService {
	/** Per-instance rolling windows for the enumeration-safe request endpoints. */
	private readonly requestWindow = new Map<string, number[]>();
	/** Outstanding, single-use WebAuthn challenges. Per-process until the identity process owns them. */
	private readonly passkeyChallenges = new Map<string, PasskeyChallengeRecord>();
	/** Password-verified sign-ins waiting for a TOTP or recovery code. */
	private readonly mfaChallenges = new Map<string, MfaChallengeRecord>();

	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- users and sessions

	/**
	 * Create a pool user. `open` pools accept anybody; `invite` pools need a pending invite for the
	 * address, or its raw token. An invitation proves the address, so that user starts verified.
	 */
	async signUp(
		poolId: string,
		email: string,
		password: string,
		name?: string,
		options: { inviteToken?: string } = {}
	): Promise<UserPoolSignUpResult> {
		const pool = this.requireEnabledPool(poolId);
		const address = normalizeEmail(email);
		validatePassword(password);

		const existing = this.ctx.sqlite
			.query<UserRow, [string, string]>('SELECT * FROM user_pool_users WHERE pool_id = ? AND email = ?')
			.get(pool.id, address);
		if (existing) throw new ConflictError('An account with that email already exists.');

		let invite: InviteRow | null = null;
		if (pool.signup_mode === 'invite') {
			invite = this.findInvite(pool.id, address, options.inviteToken);
			if (!invite)
				throw new ForbiddenError(
					'userPool:signup',
					'This pool is invite-only. Ask an administrator for an invitation.'
				);
		}

		const now = this.ctx.now();
		const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });
		const id = newId('upu_');
		const displayName = (name ?? '').trim().slice(0, 120);

		this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run(
				`INSERT INTO user_pool_users
				   (id, pool_id, email, email_verified_at, password_hash, name, metadata_json, created_at, updated_at, disabled_at)
				 VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, NULL)`,
				[id, pool.id, address, invite ? now : null, passwordHash, displayName, now, now]
			);
			if (invite)
				this.ctx.sqlite.run('UPDATE user_pool_invites SET used_at = ? WHERE id = ? AND used_at IS NULL', [
					now,
					invite.id
				]);
		})();

		const user = this.requireUser(pool.id, id);
		// D122: pool activity goes to queues. Metadata only: no password, token or client secret.
		this.ctx.events.emitUserPool(pool.org_id, pool.id, 'user.created', {
			poolId: pool.id,
			poolName: pool.name,
			user: {
				id: user.id,
				email: user.email,
				name: user.name,
				emailVerified: user.email_verified_at !== null
			}
		});
		let verificationToken: string | null = null;
		if (!invite) {
			verificationToken = this.issueEmailToken(pool.id, id, 'verify_email', now).token;
			await this.sendLinkMail(pool, user, 'verify_email', verificationToken);
		}
		return { user: userView(user), verificationToken };
	}

	/**
	 * Verify an email + password pair and start a pool session. An invite-only pool (or an open
	 * pool that opted in) refuses an unverified address; an open pool lets it in and reports the
	 * pending verification so the hosted page can nag.
	 */
	async signIn(poolId: string, email: string, password: string): Promise<UserPoolSignInResult> {
		const pool = this.requireEnabledPool(poolId);
		const address = normalizeEmail(email);
		const user = this.findUser(pool.id, address);

		// One message for missing users, wrong passwords and disabled accounts: no account oracle.
		const refusal = new UnauthorizedError('That email and password do not match an account in this pool.');
		if (!user) throw refusal;
		const valid = await Bun.password.verify(password, user.password_hash);
		if (!valid || user.disabled_at !== null) throw refusal;
		if (this.emailVerificationRequired(pool) && user.email_verified_at === null)
			throw new CoreError('email_unverified', 'Verify your email address before signing in.', 403);

		// MFA is a second step, not a different password: the challenge token is not a session and
		// `session()` refuses it. The hosted page swaps it for a real session in `totpVerify`.
		if (this.totpEnabled(pool.id, user.id)) {
			const challenge = this.issueMfaChallenge(pool.id, user.id);
			const session = {
				id: sha256Hex(challenge.token),
				poolId: pool.id,
				userId: user.id,
				expiresAt: challenge.expiresAt,
				createdAt: this.ctx.now(),
				lastSeenAt: null,
				revokedAt: null
			};
			return {
				token: challenge.token,
				user: userView(user),
				session,
				emailVerificationPending: user.email_verified_at === null,
				mfaRequired: true,
				mfaToken: challenge.token,
				mfaExpiresAt: challenge.expiresAt
			};
		}

		return this.startSession(pool, user, 'password');
	}

	/**
	 * Request a magic sign-in link. Always resolves with the same shape for a known and an unknown
	 * address: the caller never learns whether the account exists, and the limiter is charged in
	 * both cases.
	 */
	async requestMagicLink(
		poolId: string,
		email: string,
		options: { ip?: string | null } = {}
	): Promise<void> {
		const pool = this.requireEnabledPool(poolId);
		const address = normalizeEmail(email);
		if (
			!this.allowRequest(`magic:ip:${pool.id}:${options.ip ?? 'unknown'}`, USER_POOL_REQUEST_IP_LIMIT) ||
			!this.allowRequest(`magic:email:${pool.id}:${address}`, USER_POOL_MAGIC_EMAIL_LIMIT)
		)
			return;
		const user = this.findUser(pool.id, address);
		if (!user || user.disabled_at !== null) return;
		const issued = this.issueEmailToken(pool.id, user.id, 'magic_link');
		await this.sendLinkMail(pool, user, 'magic_link', issued.token);
	}

	/** Consume a magic link: proves the address, marks it verified and starts a session. */
	async magicLinkSignIn(poolId: string, token: string): Promise<UserPoolSignInResult> {
		const pool = this.requireEnabledPool(poolId);
		const user = this.consumeEmailToken(pool.id, token, 'magic_link');
		const now = this.ctx.now();
		if (user.email_verified_at === null)
			this.ctx.sqlite.run(
				'UPDATE user_pool_users SET email_verified_at = ?, updated_at = ? WHERE id = ? AND pool_id = ?',
				[now, now, user.id, pool.id]
			);
		return this.startSession(pool, this.requireUser(pool.id, user.id), 'magic_link');
	}

	// ---------------------------------------------------------------- passkeys (WebAuthn)

	/**
	 * Start enrolling a passkey for a signed-in pool user. The options are bound to the pool, the
	 * user and a server-side challenge; `challengeId` is the only value the browser is trusted to
	 * echo back. `origin` is the hosted page's origin, checked against the pool issuer.
	 */
	async passkeyRegisterOptions(
		poolId: string,
		userId: string,
		origin: string
	): Promise<UserPoolPasskeyRegistrationChallenge> {
		const pool = this.requireEnabledPool(poolId);
		const user = this.requireUser(pool.id, userId);
		if (user.disabled_at !== null) throw new UnauthorizedError('Sign in first.');
		if (!this.allowRequest(`passkey-register:${pool.id}:${user.id}`, USER_POOL_PASSKEY_REGISTER_LIMIT))
			throw new RateLimitError('Too many passkey attempts. Wait a few minutes and try again.');

		const rp = userPoolPasskeyRelyingParty(pool.issuer, origin);
		const existing = this.passkeyRows(pool.id, user.id);
		const options = await this.webAuthnGeneration(async (provider) =>
			provider.generateRegistrationOptions({
				rpName: pool.name,
				rpID: rp.rpId,
				userName: user.email,
				userID: new TextEncoder().encode(user.id),
				userDisplayName: user.name || user.email,
				attestationType: 'none',
				excludeCredentials: existing.map((row) => ({
					id: row.credential_id,
					transports: parseTransports(row.transports_json)
				})),
				authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
			})
		);
		const issued = this.issuePasskeyChallenge({
			poolId: pool.id,
			type: 'registration',
			userId: user.id,
			emailHint: user.email,
			challenge: options.challenge,
			rpId: rp.rpId,
			origin: rp.origin
		});
		return { challengeId: issued.challengeId, expiresAt: issued.expiresAt, options };
	}

	/**
	 * Finish enrollment. The challenge must belong to this pool and user, must be unused and
	 * unexpired, and the authenticator must report user verification. A credential id is unique
	 * across the platform, so re-registering the same authenticator is a conflict.
	 */
	async passkeyRegisterVerify(input: UserPoolPasskeyRegisterVerifyInput): Promise<UserPoolPasskeyView> {
		const refusal = new UnauthorizedError('That passkey could not be registered. Try again.');
		const pool = this.requireEnabledPool(input.poolId);
		const user = this.requireUser(pool.id, input.userId);
		if (user.disabled_at !== null) throw refusal;
		const challenge = this.consumePasskeyChallenge(pool.id, input.challengeId, 'registration');
		if (challenge.userId !== user.id) throw refusal;

		const verified = await this.webAuthnVerification(async (provider) =>
			provider.verifyRegistrationResponse({
				response: input.response,
				expectedChallenge: challenge.challenge,
				expectedOrigin: challenge.origin,
				expectedRPID: challenge.rpId,
				requireUserVerification: true
			})
		);
		if (!verified.verified || !verified.registrationInfo) throw refusal;
		const credential = verified.registrationInfo.credential;
		if (!credential?.id || !credential.publicKey?.length) throw refusal;

		const existing = this.ctx.sqlite
			.query<{ id: string }, [string]>('SELECT id FROM user_pool_passkeys WHERE credential_id = ?')
			.get(credential.id);
		if (existing) throw new ConflictError('That passkey is already registered.');

		const now = this.ctx.now();
		const id = newId('uppk_');
		const transports = Array.isArray(credential.transports)
			? credential.transports.filter((item): item is string => typeof item === 'string')
			: [];
		try {
			this.ctx.sqlite.run(
				`INSERT INTO user_pool_passkeys
				   (id, pool_id, user_id, credential_id, public_key, counter, transports_json, name,
				    created_at, last_used_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
				[
					id,
					pool.id,
					user.id,
					credential.id,
					Buffer.from(credential.publicKey).toString('base64url'),
					Math.max(0, Math.trunc(credential.counter ?? 0)),
					JSON.stringify(transports),
					passkeyName(input.name, transports),
					now
				]
			);
		} catch (cause) {
			if (cause instanceof Error && /UNIQUE/i.test(cause.message))
				throw new ConflictError('That passkey is already registered.');
			throw cause;
		}
		return passkeyView(this.requirePasskey(pool.id, user.id, id));
	}

	/**
	 * Start a passkey sign-in. Options are always discoverable (`allowCredentials` is empty), so
	 * the answer reveals nothing about whether `email` maps to an account; the hint is only used to
	 * reject a credential that belongs to somebody else after verification.
	 */
	async passkeyLoginOptions(
		poolId: string,
		email?: string | null,
		options: { origin?: string | null } = {}
	): Promise<UserPoolPasskeyAuthenticationChallenge> {
		const pool = this.requireEnabledPool(poolId);
		const hint = email?.trim() ? normalizeEmail(email) : null;
		if (
			!this.allowRequest(`passkey-login:pool:${pool.id}`, USER_POOL_PASSKEY_POOL_LIMIT) ||
			!this.allowRequest(
				`passkey-login:hint:${pool.id}:${hint ?? 'discoverable'}`,
				USER_POOL_PASSKEY_LOGIN_LIMIT
			)
		)
			throw new RateLimitError('Too many passkey attempts. Wait a few minutes and try again.');

		const rp = userPoolPasskeyRelyingParty(pool.issuer, options.origin);
		const generated = await this.webAuthnGeneration(async (provider) =>
			provider.generateAuthenticationOptions({
				rpID: rp.rpId,
				userVerification: 'required'
			})
		);
		const issued = this.issuePasskeyChallenge({
			poolId: pool.id,
			type: 'authentication',
			userId: null,
			emailHint: hint,
			challenge: generated.challenge,
			rpId: rp.rpId,
			origin: rp.origin
		});
		return { challengeId: issued.challengeId, expiresAt: issued.expiresAt, options: generated };
	}

	/**
	 * Verify a passkey assertion, advance its counter and start a pool session. Every failure is
	 * one generic refusal. A counter that does not advance (or a concurrent update losing the
	 * compare-and-set) is treated as a possible clone and refused without touching the counter.
	 */
	async passkeyLoginVerify(input: UserPoolPasskeyLoginVerifyInput): Promise<UserPoolSignInResult> {
		const refusal = new UnauthorizedError('Passkey sign-in failed.');
		const pool = this.requireEnabledPool(input.poolId);
		if (
			!this.allowRequest(
				`passkey-verify:${pool.id}:${input.ip ?? 'unknown'}`,
				USER_POOL_PASSKEY_LOGIN_LIMIT
			) ||
			!this.allowRequest(`passkey-verify:pool:${pool.id}`, USER_POOL_PASSKEY_POOL_LIMIT)
		)
			throw new RateLimitError('Too many passkey attempts. Wait a few minutes and try again.');

		const challenge = this.consumePasskeyChallenge(pool.id, input.challengeId, 'authentication');
		const credentialId = input.response?.id;
		if (!credentialId) throw refusal;
		const row = this.ctx.sqlite
			.query<UserPoolPasskeyRow, [string, string]>(
				'SELECT * FROM user_pool_passkeys WHERE credential_id = ? AND pool_id = ?'
			)
			.get(credentialId, pool.id);
		if (!row) throw refusal;
		const user = this.ctx.sqlite
			.query<UserRow, [string, string]>('SELECT * FROM user_pool_users WHERE id = ? AND pool_id = ?')
			.get(row.user_id, pool.id);
		if (!user || user.disabled_at !== null) throw refusal;
		if (challenge.emailHint !== null && user.email !== challenge.emailHint) throw refusal;

		const verified = await this.webAuthnVerification(async (provider) =>
			provider.verifyAuthenticationResponse({
				response: input.response,
				expectedChallenge: challenge.challenge,
				expectedOrigin: challenge.origin,
				expectedRPID: challenge.rpId,
				credential: {
					id: row.credential_id,
					publicKey: Buffer.from(row.public_key, 'base64url'),
					counter: row.counter,
					transports: parseTransports(row.transports_json)
				},
				requireUserVerification: true
			})
		);
		if (!verified.verified || !verified.authenticationInfo) throw refusal;

		const nextCounter = verified.authenticationInfo.newCounter;
		if (!passkeyCounterAccepted(row.counter, nextCounter)) {
			// Ids only: never log the credential or the user's address.
			console.warn(`[user-pool] passkey counter did not advance for pool ${pool.id}; refusing.`);
			throw refusal;
		}
		const now = this.ctx.now();
		const updated = this.ctx.sqlite.run(
			`UPDATE user_pool_passkeys
			    SET counter = ?, last_used_at = ?
			  WHERE credential_id = ? AND pool_id = ? AND counter = ?`,
			[nextCounter, now, row.credential_id, pool.id, row.counter]
		);
		// A lost compare-and-set means another request consumed the same assertion first.
		if (updated.changes === 0) throw refusal;

		return this.startSession(pool, this.requireUser(pool.id, user.id), 'passkey');
	}

	/** Passkeys enrolled by one user, newest first. Never includes the credential or public key. */
	listPasskeys(poolId: string, userId: string): UserPoolPasskeyView[] {
		this.requireUser(poolId, userId);
		return this.passkeyRows(poolId, userId).map(passkeyView);
	}

	/** Remove one passkey. Returns false when it was already gone (or belongs to another user). */
	deletePasskey(poolId: string, userId: string, passkeyId: string): boolean {
		const result = this.ctx.sqlite.run(
			'DELETE FROM user_pool_passkeys WHERE id = ? AND pool_id = ? AND user_id = ?',
			[passkeyId, poolId, userId]
		);
		return result.changes > 0;
	}

	// ---------------------------------------------------------------- TOTP MFA

	/** Whether the pool asks every user to enrol MFA. Per-user enforcement is the enrolment itself. */
	mfaRequired(poolId: string): boolean {
		this.requirePool(poolId);
		return (
			this.ctx.sqlite
				.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
				.get(userPoolMfaRequiredKey(poolId))?.value === '1'
		);
	}

	/** The user's MFA state; never the secret and never a recovery code. */
	totpStatus(poolId: string, userId: string): UserPoolTotpStatus {
		this.requireUser(poolId, userId);
		const row = this.totpRow(poolId, userId);
		const remaining = row
			? parseRecoveryCodes(row.recovery_codes_json).filter((entry) => entry.usedAt === null).length
			: 0;
		return {
			enabled: Boolean(row?.confirmed_at),
			confirmedAt: row?.confirmed_at ?? null,
			recoveryCodesRemaining: remaining
		};
	}

	/**
	 * Start TOTP enrolment: generate a 160-bit base32 secret, seal it with the org data key and
	 * return the secret and `otpauth://` URI exactly once. Repeating this before confirmation
	 * replaces the abandoned secret; a confirmed enrolment must be disabled first.
	 */
	totpEnrol(poolId: string, userId: string): UserPoolTotpEnrolment {
		const pool = this.requireEnabledPool(poolId);
		const user = this.requireUser(pool.id, userId);
		if (user.disabled_at !== null) throw new UnauthorizedError('Sign in first.');
		const existing = this.totpRow(pool.id, user.id);
		if (existing?.confirmed_at) throw new ConflictError('Two-factor authentication is already enabled.');

		const secret = base32Encode(randomBytes(20));
		const now = this.ctx.now();
		this.ctx.sqlite.run(
			`INSERT INTO user_pool_totp
			   (user_id, pool_id, secret_sealed, confirmed_at, last_step, recovery_codes_json, created_at)
			 VALUES (?, ?, ?, NULL, NULL, '[]', ?)
			 ON CONFLICT(pool_id, user_id) DO UPDATE SET
			   secret_sealed = excluded.secret_sealed,
			   confirmed_at = NULL,
			   last_step = NULL,
			   recovery_codes_json = '[]',
			   created_at = excluded.created_at`,
			[user.id, pool.id, this.ctx.secrets.seal(pool.org_id, secret), now]
		);
		const issuer = pool.name;
		const account = user.email;
		const label = `${issuer}:${account}`;
		const otpauthUri = `otpauth://totp/${encodeURIComponent(label)}?${new URLSearchParams({
			secret,
			issuer,
			algorithm: 'SHA1',
			digits: String(USER_POOL_TOTP_DIGITS),
			period: String(USER_POOL_TOTP_PERIOD_SECONDS)
		}).toString()}`;
		return { secret, otpauthUri, account, issuer };
	}

	/**
	 * Finish enrolment with the first valid code. This is the only time the recovery codes are
	 * returned; only their hashes are stored. A code already accepted is refused by the replay guard.
	 */
	totpConfirm(poolId: string, userId: string, code: string): UserPoolRecoveryCodes {
		const pool = this.requireEnabledPool(poolId);
		const user = this.requireUser(pool.id, userId);
		const row = this.totpRow(pool.id, user.id);
		if (!row) throw new NotFoundError('TOTP enrolment');
		if (row.confirmed_at !== null) throw new ConflictError('Two-factor authentication is already enabled.');
		const secret = this.ctx.secrets.open(pool.org_id, row.secret_sealed);
		const step = verifyUserPoolTotp(secret, code, this.ctx.now());
		if (step === null) throw new UnauthorizedError('That code is not valid. Try the next one.');
		if (row.last_step !== null && step <= row.last_step)
			throw new UnauthorizedError('That code has already been used.');

		const recoveryCodes = generateRecoveryCodes(USER_POOL_RECOVERY_CODE_COUNT);
		const now = this.ctx.now();
		const updated = this.ctx.sqlite.run(
			`UPDATE user_pool_totp
			    SET confirmed_at = ?, last_step = ?, recovery_codes_json = ?
			  WHERE pool_id = ? AND user_id = ? AND confirmed_at IS NULL
			    AND (last_step IS NULL OR last_step < ?)`,
			[
				now,
				step,
				JSON.stringify(recoveryCodes.map((value) => ({ hash: recoveryCodeHash(value), usedAt: null }))),
				pool.id,
				user.id,
				step
			]
		);
		if (updated.changes === 0) throw new ConflictError('Two-factor authentication is already enabled.');
		this.ctx.events.emitUserPool(pool.org_id, pool.id, 'mfa.enabled', {
			poolId: pool.id,
			poolName: pool.name,
			user: { id: user.id, email: user.email, name: user.name },
			method: 'totp'
		});
		return { recoveryCodes };
	}

	/**
	 * Verify the second factor for a password-verified sign-in and create the session. The challenge
	 * is single use and spends one of five attempts on every wrong code; a matching recovery code is
	 * consumed here rather than re-entering the TOTP window.
	 */
	totpVerify(poolId: string, mfaToken: string, code: string): UserPoolSignInResult {
		const pool = this.requireEnabledPool(poolId);
		const refusal = new UnauthorizedError('That code is not valid.');
		const challenge = mfaToken ? this.mfaChallenges.get(mfaToken) : undefined;
		if (!challenge || challenge.poolId !== pool.id) throw refusal;
		if (challenge.expiresAt <= this.ctx.now()) {
			this.mfaChallenges.delete(mfaToken);
			throw refusal;
		}
		if (challenge.attempts >= USER_POOL_MFA_MAX_ATTEMPTS) {
			this.mfaChallenges.delete(mfaToken);
			throw new RateLimitError('Too many incorrect codes. Sign in again.');
		}
		const user = this.requireUser(pool.id, challenge.userId);
		if (user.disabled_at !== null) {
			this.mfaChallenges.delete(mfaToken);
			throw refusal;
		}

		const verification = this.verifyMfaCode(pool, user.id, code);
		if (!verification.ok) {
			challenge.attempts += 1;
			if (challenge.attempts >= USER_POOL_MFA_MAX_ATTEMPTS) this.mfaChallenges.delete(mfaToken);
			throw refusal;
		}
		this.mfaChallenges.delete(mfaToken);
		return this.startSession(
			pool,
			user,
			verification.usedRecoveryCode ? 'recovery_code' : 'totp'
		);
	}

	/** Replace the unused recovery codes, after proving possession with a current code. */
	regenerateRecoveryCodes(poolId: string, userId: string, code: string): UserPoolRecoveryCodes {
		const pool = this.requireEnabledPool(poolId);
		const user = this.requireUser(pool.id, userId);
		const verification = this.verifyMfaCode(pool, user.id, code);
		if (!verification.ok) throw new UnauthorizedError('That code is not valid.');
		const recoveryCodes = generateRecoveryCodes(USER_POOL_RECOVERY_CODE_COUNT);
		this.ctx.sqlite.run(
			'UPDATE user_pool_totp SET recovery_codes_json = ? WHERE pool_id = ? AND user_id = ?',
			[
				JSON.stringify(recoveryCodes.map((value) => ({ hash: recoveryCodeHash(value), usedAt: null }))),
				pool.id,
				user.id
			]
		);
		return { recoveryCodes };
	}

	/** Disable TOTP. Proving a current code stops a stolen session from removing the factor. */
	totpDisable(poolId: string, userId: string, code: string): boolean {
		const pool = this.requireEnabledPool(poolId);
		const user = this.requireUser(pool.id, userId);
		const verification = this.verifyMfaCode(pool, user.id, code);
		if (!verification.ok) throw new UnauthorizedError('That code is not valid.');
		const deleted = this.ctx.sqlite.run(
			'DELETE FROM user_pool_totp WHERE pool_id = ? AND user_id = ? AND confirmed_at IS NOT NULL',
			[pool.id, user.id]
		);
		return deleted.changes > 0;
	}

	/** Request a password-reset link. Enumeration-safe and rate limited like a magic link. */
	async requestPasswordReset(
		poolId: string,
		email: string,
		options: { ip?: string | null } = {}
	): Promise<void> {
		const pool = this.requireEnabledPool(poolId);
		const address = normalizeEmail(email);
		if (
			!this.allowRequest(`reset:ip:${pool.id}:${options.ip ?? 'unknown'}`, USER_POOL_REQUEST_IP_LIMIT) ||
			!this.allowRequest(`reset:email:${pool.id}:${address}`, USER_POOL_RESET_EMAIL_LIMIT)
		)
			return;
		const user = this.findUser(pool.id, address);
		if (!user || user.disabled_at !== null) return;
		const issued = this.issueEmailToken(pool.id, user.id, 'password_reset');
		await this.sendLinkMail(pool, user, 'password_reset', issued.token);
	}

	/**
	 * Consume a reset link, set a new password and revoke every session that came before it. The
	 * browser doing the reset gets a fresh session, so it stays signed in while other devices drop.
	 */
	async resetPassword(poolId: string, token: string, newPassword: string): Promise<UserPoolSignInResult> {
		const pool = this.requireEnabledPool(poolId);
		validatePassword(newPassword);
		// Hash before consuming: a hashing failure must not burn the link.
		const passwordHash = await Bun.password.hash(newPassword, { algorithm: 'argon2id' });
		const user = this.consumeEmailToken(pool.id, token, 'password_reset');
		const now = this.ctx.now();
		this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run(
				`UPDATE user_pool_users
				    SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?), updated_at = ?
				  WHERE id = ? AND pool_id = ?`,
				[passwordHash, now, now, user.id, pool.id]
			);
			this.ctx.sqlite.run(
				'UPDATE user_pool_sessions SET revoked_at = ? WHERE pool_id = ? AND user_id = ? AND revoked_at IS NULL',
				[now, pool.id, user.id]
			);
		})();
		return this.startSession(pool, this.requireUser(pool.id, user.id), 'password_reset');
	}

	/** Re-send a verification link for an unverified address. Enumeration-safe. */
	async requestEmailVerification(
		poolId: string,
		email: string,
		options: { ip?: string | null } = {}
	): Promise<void> {
		const pool = this.requireEnabledPool(poolId);
		const address = normalizeEmail(email);
		if (
			!this.allowRequest(`verify:ip:${pool.id}:${options.ip ?? 'unknown'}`, USER_POOL_REQUEST_IP_LIMIT) ||
			!this.allowRequest(`verify:email:${pool.id}:${address}`, USER_POOL_VERIFY_EMAIL_LIMIT)
		)
			return;
		const user = this.findUser(pool.id, address);
		if (!user || user.disabled_at !== null || user.email_verified_at !== null) return;
		const issued = this.issueEmailToken(pool.id, user.id, 'verify_email');
		await this.sendLinkMail(pool, user, 'verify_email', issued.token);
	}

	/** Insert a session row and emit the D122 event; shared by every completed sign-in method. */
	private startSession(
		pool: UserPoolRow,
		user: UserRow,
		method: 'password' | 'magic_link' | 'password_reset' | 'passkey' | 'totp' | 'recovery_code'
	): UserPoolSignInResult {
		const now = this.ctx.now();
		const token = randomToken(32);
		const id = sha256Hex(token);
		const expiresAt = now + USER_POOL_SESSION_TTL_SECONDS * 1000;
		this.ctx.sqlite.run(
			`INSERT INTO user_pool_sessions
			   (id, pool_id, user_id, expires_at, created_at, last_seen_at, revoked_at)
			 VALUES (?, ?, ?, ?, ?, ?, NULL)`,
			[id, pool.id, user.id, expiresAt, now, now]
		);
		// D122: sign-in metadata only. The raw session token never leaves this method.
		this.ctx.events.emitUserPool(pool.org_id, pool.id, 'user.signed_in', {
			poolId: pool.id,
			poolName: pool.name,
			user: { id: user.id, email: user.email, name: user.name },
			session: { id, expiresAt },
			method
		});
		return {
			token,
			user: userView(user),
			session: {
				id,
				poolId: pool.id,
				userId: user.id,
				expiresAt,
				createdAt: now,
				lastSeenAt: now,
				revokedAt: null
			},
			emailVerificationPending: user.email_verified_at === null,
			mfaRequired: false
		};
	}

	/** Resolve a raw session token, or null when expired, revoked or belonging to a disabled row. */
	session(poolId: string, token: string | null | undefined): UserPoolSessionContext | null {
		if (!token) return null;
		const id = sha256Hex(token);
		const session = this.ctx.sqlite
			.query<SessionRow, [string, string]>('SELECT * FROM user_pool_sessions WHERE id = ? AND pool_id = ?')
			.get(id, poolId);
		if (!session || session.revoked_at !== null) return null;
		const now = this.ctx.now();
		if (session.expires_at <= now) return null;

		const user = this.ctx.sqlite
			.query<UserRow, [string, string]>(
				`SELECT u.* FROM user_pool_users u
				  JOIN user_pools p ON p.id = u.pool_id
				  WHERE u.id = ? AND u.pool_id = ? AND u.disabled_at IS NULL AND p.disabled_at IS NULL`
			)
			.get(session.user_id, poolId);
		if (!user) return null;

		// The idle clock is written at most once a minute, as the platform does for its own sessions.
		if (session.last_seen_at === null || now - session.last_seen_at > 60_000) {
			this.ctx.sqlite.run('UPDATE user_pool_sessions SET last_seen_at = ? WHERE id = ?', [now, session.id]);
			session.last_seen_at = now;
		}
		return { user: userView(user), session: sessionView(session) };
	}

	/** Revoke one session. Returns false when it was already gone. */
	signOut(poolId: string, token: string | null | undefined): boolean {
		if (!token) return false;
		const result = this.ctx.sqlite.run(
			'UPDATE user_pool_sessions SET revoked_at = ? WHERE id = ? AND pool_id = ? AND revoked_at IS NULL',
			[this.ctx.now(), sha256Hex(token), poolId]
		);
		return result.changes > 0;
	}

	/** Consume a verification link token and mark the user verified. */
	verifyEmail(poolId: string, token: string): UserPoolUserView {
		const pool = this.requireEnabledPool(poolId);
		const user = this.consumeEmailToken(pool.id, token, 'verify_email');
		const now = this.ctx.now();
		this.ctx.sqlite.run(
			'UPDATE user_pool_users SET email_verified_at = ?, updated_at = ? WHERE id = ? AND pool_id = ?',
			[now, now, user.id, pool.id]
		);
		return userView(this.requireUser(pool.id, user.id));
	}

	/** Issue (and store) a fresh email-verification token. The raw token is returned once. */
	issueEmailVerification(
		poolId: string,
		userId: string,
		now = this.ctx.now()
	): { token: string; expiresAt: number } {
		return this.issueEmailToken(poolId, userId, 'verify_email', now);
	}

	// ---------------------------------------------------------------- invites and admin

	/** Mint an invite. The raw token is shown once and can be pasted into the sign-up page. */
	createInvite(
		poolId: string,
		email: string,
		options: { createdBy?: string | null; ttlSeconds?: number } = {}
	): UserPoolInviteCreated {
		const pool = this.requireEnabledPool(poolId);
		const address = normalizeEmail(email);
		const existing = this.ctx.sqlite
			.query<{ id: string }, [string, string]>('SELECT id FROM user_pool_users WHERE pool_id = ? AND email = ?')
			.get(pool.id, address);
		if (existing) throw new ConflictError('An account with that email already exists.');

		const now = this.ctx.now();
		const ttl = Math.max(60, options.ttlSeconds ?? USER_POOL_INVITE_TTL_SECONDS);
		const token = randomToken(32);
		const id = newId('upi_');
		const expiresAt = now + ttl * 1000;
		this.ctx.sqlite.run(
			`INSERT INTO user_pool_invites
			   (id, pool_id, email, token_hash, created_by, created_at, expires_at, used_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
			[id, pool.id, address, sha256Hex(token), options.createdBy ?? null, now, expiresAt]
		);
		// The invitation leaves as mail; the raw token is still returned once for a manual copy.
		void this.sendInviteMail(pool, address, token, expiresAt);
		return {
			invite: {
				id,
				poolId: pool.id,
				email: address,
				createdBy: options.createdBy ?? null,
				createdAt: now,
				expiresAt,
				usedAt: null
			},
			token
		};
	}

	listUsers(poolId: string): UserPoolUserView[] {
		this.requirePool(poolId);
		return this.ctx.sqlite
			.query<UserRow, [string]>('SELECT * FROM user_pool_users WHERE pool_id = ? ORDER BY created_at')
			.all(poolId)
			.map(userView);
	}

	listInvites(poolId: string): UserPoolInviteView[] {
		this.requirePool(poolId);
		return this.ctx.sqlite
			.query<InviteRow, [string]>('SELECT * FROM user_pool_invites WHERE pool_id = ? ORDER BY created_at DESC')
			.all(poolId)
			.map(inviteView);
	}

	// ---------------------------------------------------------------- groups

	/** Groups in one pool, with member counts. Names are unique case-insensitively per pool. */
	listGroups(poolId: string): UserPoolGroupView[] {
		this.requirePool(poolId);
		return this.ctx.sqlite
			.query<UserPoolGroupRow, [string]>(
				`SELECT g.id, g.pool_id, g.name, g.created_at,
				        (SELECT COUNT(*) FROM user_pool_group_members m WHERE m.group_id = g.id) AS member_count
				   FROM user_pool_groups g
				  WHERE g.pool_id = ?
				  ORDER BY g.name COLLATE NOCASE`
			)
			.all(poolId)
			.map(groupView);
	}

	createGroup(poolId: string, name: string): UserPoolGroupView {
		const pool = this.requireEnabledPool(poolId);
		const clean = validateGroupName(name);
		const id = newId('upg_');
		const now = this.ctx.now();
		try {
			this.ctx.sqlite.run(
				'INSERT INTO user_pool_groups (id, pool_id, name, created_at) VALUES (?, ?, ?, ?)',
				[id, pool.id, clean, now]
			);
		} catch (cause) {
			if (cause instanceof Error && /UNIQUE/i.test(cause.message))
				throw new ConflictError('A group with that name already exists.');
			throw cause;
		}
		return { id, poolId: pool.id, name: clean, createdAt: now, memberCount: 0 };
	}

	renameGroup(poolId: string, groupId: string, name: string): UserPoolGroupView {
		const pool = this.requireEnabledPool(poolId);
		const group = this.requireGroup(pool.id, groupId);
		const clean = validateGroupName(name);
		try {
			this.ctx.sqlite.run('UPDATE user_pool_groups SET name = ? WHERE id = ? AND pool_id = ?', [
				clean,
				group.id,
				pool.id
			]);
		} catch (cause) {
			if (cause instanceof Error && /UNIQUE/i.test(cause.message))
				throw new ConflictError('A group with that name already exists.');
			throw cause;
		}
		return groupView({ ...group, name: clean });
	}

	deleteGroup(poolId: string, groupId: string): boolean {
		this.requirePool(poolId);
		return this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run('DELETE FROM user_pool_group_members WHERE group_id = ? AND pool_id = ?', [
				groupId,
				poolId
			]);
			const deleted = this.ctx.sqlite.run('DELETE FROM user_pool_groups WHERE id = ? AND pool_id = ?', [
				groupId,
				poolId
			]);
			return deleted.changes > 0;
		})();
	}

	listGroupMembers(poolId: string, groupId: string): UserPoolGroupMemberView[] {
		this.requireGroup(poolId, groupId);
		return this.ctx.sqlite
			.query<UserPoolGroupMemberRow, [string, string]>(
				`SELECT m.user_id, u.email, u.name, m.created_at
				   FROM user_pool_group_members m
				   JOIN user_pool_users u ON u.id = m.user_id AND u.pool_id = m.pool_id
				  WHERE m.pool_id = ? AND m.group_id = ?
				  ORDER BY u.email COLLATE NOCASE`
			)
			.all(poolId, groupId)
			.map(groupMemberView);
	}

	addGroupMember(poolId: string, groupId: string, userId: string): void {
		const group = this.requireGroup(poolId, groupId);
		const user = this.requireUser(poolId, userId);
		if (user.disabled_at !== null) throw new ValidationError('That user is disabled.');
		this.ctx.sqlite.run(
			`INSERT INTO user_pool_group_members (pool_id, group_id, user_id, created_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(group_id, user_id) DO NOTHING`,
			[group.pool_id, group.id, user.id, this.ctx.now()]
		);
	}

	removeGroupMember(poolId: string, groupId: string, userId: string): boolean {
		this.requireGroup(poolId, groupId);
		const result = this.ctx.sqlite.run(
			'DELETE FROM user_pool_group_members WHERE pool_id = ? AND group_id = ? AND user_id = ?',
			[poolId, groupId, userId]
		);
		return result.changes > 0;
	}

	/** Group names for one user, used by `groups` claims and Skiff Access. Metadata is not consulted. */
	groupsForUser(poolId: string, userId: string): string[] {
		this.requireUser(poolId, userId);
		return this.ctx.sqlite
			.query<{ name: string }, [string, string]>(
				`SELECT g.name
				   FROM user_pool_group_members m
				   JOIN user_pool_groups g ON g.id = m.group_id AND g.pool_id = m.pool_id
				  WHERE m.pool_id = ? AND m.user_id = ?
				  ORDER BY g.name COLLATE NOCASE`
			)
			.all(poolId, userId)
			.map((row) => row.name);
	}

	user(poolId: string, userId: string): UserPoolUserView {
		return userView(this.requireUser(poolId, userId));
	}

	/** Disable or re-enable a user. Disabling revokes every live session immediately. */
	setUserDisabled(poolId: string, userId: string, disabled: boolean): UserPoolUserView {
		const user = this.requireUser(poolId, userId);
		const now = this.ctx.now();
		this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run('UPDATE user_pool_users SET disabled_at = ?, updated_at = ? WHERE id = ?', [
				disabled ? (user.disabled_at ?? now) : null,
				now,
				user.id
			]);
			if (disabled)
				this.ctx.sqlite.run(
					'UPDATE user_pool_sessions SET revoked_at = ? WHERE pool_id = ? AND user_id = ? AND revoked_at IS NULL',
					[now, poolId, user.id]
				);
			if (disabled) this.forgetMfaChallenges(poolId, user.id);
		})();
		return userView(this.requireUser(poolId, user.id));
	}

	/** GDPR delete: remove the user and everything keyed to them. Returns false when absent. */
	deleteUser(poolId: string, userId: string): boolean {
		const user = this.ctx.sqlite
			.query<{ id: string }, [string, string]>('SELECT id FROM user_pool_users WHERE id = ? AND pool_id = ?')
			.get(userId, poolId);
		if (!user) return false;
		this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run('DELETE FROM user_pool_codes WHERE user_id = ? AND pool_id = ?', [user.id, poolId]);
			this.ctx.sqlite.run('DELETE FROM user_pool_sessions WHERE user_id = ? AND pool_id = ?', [user.id, poolId]);
			this.ctx.sqlite.run('DELETE FROM user_pool_email_tokens WHERE user_id = ? AND pool_id = ?', [
				user.id,
				poolId
			]);
			this.ctx.sqlite.run('DELETE FROM user_pool_passkeys WHERE user_id = ? AND pool_id = ?', [
				user.id,
				poolId
			]);
			this.ctx.sqlite.run('DELETE FROM user_pool_totp WHERE user_id = ? AND pool_id = ?', [
				user.id,
				poolId
			]);
			this.ctx.sqlite.run('DELETE FROM user_pool_group_members WHERE user_id = ? AND pool_id = ?', [
				user.id,
				poolId
			]);
			this.ctx.sqlite.run('DELETE FROM user_pool_users WHERE id = ? AND pool_id = ?', [user.id, poolId]);
			this.forgetMfaChallenges(poolId, user.id);
		})();
		return true;
	}

	/** Remove every engine row for a pool; called from `UserPoolService.delete` inside its transaction. */
	purgePool(poolId: string): void {
		this.ctx.sqlite.run('DELETE FROM user_pool_codes WHERE pool_id = ?', [poolId]);
		this.ctx.sqlite.run('DELETE FROM user_pool_sessions WHERE pool_id = ?', [poolId]);
		this.ctx.sqlite.run('DELETE FROM user_pool_email_tokens WHERE pool_id = ?', [poolId]);
		this.ctx.sqlite.run('DELETE FROM user_pool_invites WHERE pool_id = ?', [poolId]);
		this.ctx.sqlite.run('DELETE FROM user_pool_passkeys WHERE pool_id = ?', [poolId]);
		this.ctx.sqlite.run('DELETE FROM user_pool_totp WHERE pool_id = ?', [poolId]);
		this.ctx.sqlite.run('DELETE FROM user_pool_group_members WHERE pool_id = ?', [poolId]);
		this.ctx.sqlite.run('DELETE FROM user_pool_groups WHERE pool_id = ?', [poolId]);
		this.ctx.sqlite.run('DELETE FROM user_pool_users WHERE pool_id = ?', [poolId]);
		this.forgetMfaChallenges(poolId);
	}

	// ---------------------------------------------------------------- OIDC authorization code flow

	/**
	 * Validate an authorization request and either issue a code or send the browser to the hosted
	 * login page. An invalid client or unregistered redirect is a hard error (never redirected);
	 * every other OAuth error is returned to the client's registered callback with `error`.
	 */
	async authorize(input: UserPoolAuthorizeInput): Promise<UserPoolAuthorizeResult> {
		const pool = this.requireEnabledPool(input.poolId);
		const client = this.requireClient(pool.id, input.clientId);
		const redirects = parseRedirectUris(client);
		if (!redirects.includes(input.redirectUri))
			throw new ValidationError('The redirect_uri is not registered for this client.');

		const scopes = parseScopes(input.scope);
		if (!scopes)
			return this.authorizeError(pool.id, input, 'invalid_scope', 'The requested scope is not supported.');
		if (input.responseType !== 'code')
			return this.authorizeError(
				pool.id,
				input,
				'unsupported_response_type',
				'Only the authorization code flow is supported.'
			);

		if (
			(input.codeChallenge && input.codeChallengeMethod !== 'S256') ||
			(client.public === 1 && (!input.codeChallenge || input.codeChallengeMethod !== 'S256'))
		)
			return this.authorizeError(
				pool.id,
				input,
				'invalid_request',
				'A public client must send a PKCE S256 code challenge.'
			);

		const context = this.session(pool.id, input.sessionToken);
		if (!context) {
			const returnTo = input.requestUrl ?? this.authorizeUrl(input);
			const login = new URL(`/pool/${pool.id}/login`, this.ctx.config.platformOrigin);
			login.searchParams.set('return_to', returnTo);
			return { redirect: login.toString(), needsLogin: true };
		}

		const code = randomToken(32);
		const now = this.ctx.now();
		this.ctx.sqlite.run(
			`INSERT INTO user_pool_codes
			   (code_hash, pool_id, client_id, user_id, redirect_uri, scope, nonce, code_challenge,
			    code_challenge_method, expires_at, used_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
			[
				sha256Hex(code),
				pool.id,
				client.client_id,
				context.user.id,
				input.redirectUri,
				scopes.join(' '),
				input.nonce ?? null,
				input.codeChallenge ?? null,
				input.codeChallenge ? (input.codeChallengeMethod ?? 'S256') : null,
				now + USER_POOL_CODE_TTL_SECONDS * 1000,
				now
			]
		);
		return {
			redirect: appendQuery(input.redirectUri, { code, state: input.state }),
			needsLogin: false
		};
	}

	/**
	 * Exchange an authorization code for tokens. Confidential clients prove themselves with the
	 * sealed client secret; public clients prove PKCE. A code is consumed exactly once.
	 */
	async token(input: UserPoolTokenInput): Promise<UserPoolTokenResult> {
		if (input.grantType !== 'authorization_code')
			throw new ValidationError('Only the authorization_code grant is supported.');
		if (!input.code) throw new ValidationError('An authorization code is required.');
		const pool = this.requireEnabledPool(input.poolId);
		const client = this.requireClient(pool.id, input.clientId);
		this.verifyClientSecret(pool, client, input.clientSecret);

		const row = this.ctx.sqlite
			.query<CodeRow, [string, string]>('SELECT * FROM user_pool_codes WHERE code_hash = ? AND pool_id = ?')
			.get(sha256Hex(input.code), pool.id);
		if (!row || row.used_at !== null || row.expires_at <= this.ctx.now())
			throw new UnauthorizedError('The authorization code is invalid, expired or already used.');
		if (row.client_id !== client.client_id)
			throw new UnauthorizedError('The authorization code belongs to another client.');
		if (input.redirectUri && input.redirectUri !== row.redirect_uri)
			throw new UnauthorizedError('The redirect_uri does not match the authorization request.');

		if (row.code_challenge) {
			if (row.code_challenge_method !== 'S256' || !input.codeVerifier)
				throw new UnauthorizedError('A PKCE code_verifier is required.');
			if (!safeEqual(sha256Base64Url(input.codeVerifier), row.code_challenge))
				throw new UnauthorizedError('The PKCE verification failed.');
		} else if (client.public === 1) {
			throw new UnauthorizedError('A PKCE code_verifier is required for a public client.');
		}

		const used = this.ctx.sqlite.run(
			'UPDATE user_pool_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL',
			[this.ctx.now(), row.code_hash]
		);
		if (used.changes === 0) throw new UnauthorizedError('The authorization code was already used.');

		const user = this.requireUser(pool.id, row.user_id);
		if (user.disabled_at !== null) throw new UnauthorizedError('This account is disabled.');
		const scopes = row.scope.split(/\s+/).filter(Boolean);
		const withEmail = scopes.includes('email');
		const withProfile = scopes.includes('profile');
		const groups = this.groupsForUser(pool.id, user.id);
		const purpose = userPoolSigningPurpose(pool.id);

		const idToken = await this.ctx.signingKeys.sign(
			purpose,
			{
				sub: user.id,
				aud: client.client_id,
				...(row.nonce ? { nonce: row.nonce } : {}),
				...(withEmail ? { email: user.email, email_verified: user.email_verified_at !== null } : {}),
				...(withProfile ? { name: user.name } : {}),
				groups
			},
			USER_POOL_TOKEN_TTL_SECONDS,
			{ issuer: pool.issuer }
		);

		const accessToken = await this.ctx.signingKeys.sign(
			purpose,
			{
				sub: user.id,
				aud: client.client_id,
				scope: scopes.join(' '),
				typ: 'access',
				...(withEmail ? { email: user.email, email_verified: user.email_verified_at !== null } : {}),
				...(withProfile ? { name: user.name } : {}),
				groups
			},
			USER_POOL_TOKEN_TTL_SECONDS,
			{ issuer: pool.issuer }
		);

		return {
			access_token: accessToken,
			token_type: 'Bearer',
			expires_in: USER_POOL_TOKEN_TTL_SECONDS,
			id_token: idToken,
			scope: scopes.join(' ')
		};
	}

	/**
	 * Verify a pool access token and return its user, or null. This is deliberately forgiving: an
	 * expired, malformed, wrong-issuer or id-token value is simply "not signed in" to a caller,
	 * never an exception. The function binding's `env.AUTH.verify(request)` has the same contract.
	 */
	async verifyAccessToken(poolId: string, token: string): Promise<UserPoolUserView | null> {
		try {
			const pool = this.requireEnabledPool(poolId);
			const claims = await this.ctx.signingKeys.verify(userPoolSigningPurpose(pool.id), token, {
				issuer: pool.issuer
			});
			if (claims.typ !== 'access') return null;
			const row = this.ctx.sqlite
				.query<UserRow, [string, string]>(
					'SELECT * FROM user_pool_users WHERE id = ? AND pool_id = ? AND disabled_at IS NULL'
				)
				.get(String(claims.sub), pool.id);
			return row ? userView(row) : null;
		} catch {
			return null;
		}
	}

	/** Resolve a bearer access token to the OIDC userinfo claims. */
	async userinfo(poolId: string, accessToken: string): Promise<UserPoolUserInfo> {
		const pool = this.requireEnabledPool(poolId);
		const claims = await this.ctx.signingKeys.verify(userPoolSigningPurpose(pool.id), accessToken, {
			issuer: pool.issuer
		});
		if (claims.typ !== 'access') throw new UnauthorizedError('That token is not an access token.');
		const user = this.requireUser(pool.id, claims.sub);
		if (user.disabled_at !== null) throw new UnauthorizedError('This account is disabled.');
		const scopes = new Set(String(claims.scope ?? '').split(/\s+/).filter(Boolean));
		return {
			sub: user.id,
			...(scopes.has('email') ? { email: user.email, email_verified: user.email_verified_at !== null } : {}),
			...(scopes.has('profile') ? { name: user.name } : {}),
			groups: this.groupsForUser(pool.id, user.id)
		};
	}

	/** End a pool session. The caller decides where to send the browser afterwards. */
	logout(poolId: string, token: string | null | undefined): boolean {
		return this.signOut(poolId, token);
	}

	// ---------------------------------------------------------------- internals

	private authorizeError(
		poolId: string,
		input: UserPoolAuthorizeInput,
		error: string,
		description: string
	): UserPoolAuthorizeResult {
		return {
			redirect: appendQuery(input.redirectUri, {
				error,
				error_description: description,
				state: input.state
			}),
			needsLogin: false
		};
	}

	private authorizeUrl(input: UserPoolAuthorizeInput): string {
		const url = new URL(`/api/v1/user-pools/${input.poolId}/oauth/authorize`, this.ctx.config.platformOrigin);
		url.searchParams.set('client_id', input.clientId);
		url.searchParams.set('redirect_uri', input.redirectUri);
		url.searchParams.set('response_type', input.responseType);
		if (input.scope) url.searchParams.set('scope', input.scope);
		if (input.state) url.searchParams.set('state', input.state);
		if (input.nonce) url.searchParams.set('nonce', input.nonce);
		if (input.codeChallenge) url.searchParams.set('code_challenge', input.codeChallenge);
		if (input.codeChallengeMethod) url.searchParams.set('code_challenge_method', input.codeChallengeMethod);
		return url.toString();
	}

	private findInvite(poolId: string, email: string, token: string | undefined): InviteRow | null {
		const now = this.ctx.now();
		if (token) {
			const row = this.ctx.sqlite
				.query<InviteRow, [string, string]>(
					'SELECT * FROM user_pool_invites WHERE token_hash = ? AND pool_id = ?'
				)
				.get(sha256Hex(token), poolId);
			if (!row || row.email !== email || row.used_at !== null || row.expires_at <= now) return null;
			return row;
		}
		return (
			this.ctx.sqlite
				.query<InviteRow, [string, string, number]>(
					`SELECT * FROM user_pool_invites
					  WHERE pool_id = ? AND email = ? AND used_at IS NULL AND expires_at > ?
					  ORDER BY created_at DESC LIMIT 1`
				)
				.get(poolId, email, now) ?? null
		);
	}

	private verifyClientSecret(pool: UserPoolRow, client: ClientRow, supplied: string | null | undefined): void {
		if (client.public === 1) return;
		if (!client.client_secret_sealed)
			throw new UnauthorizedError('This client has no usable secret. Re-create it.');
		const expected = this.ctx.secrets.open(pool.org_id, client.client_secret_sealed);
		if (!supplied || !safeEqual(expected, supplied))
			throw new UnauthorizedError('Invalid client credentials.');
	}

	private findUser(poolId: string, email: string): UserRow | null {
		return (
			this.ctx.sqlite
				.query<UserRow, [string, string]>(
					'SELECT * FROM user_pool_users WHERE pool_id = ? AND email = ?'
				)
				.get(poolId, email) ?? null
		);
	}

	/** Invite-only always requires verification; an open pool may opt in through its setting. */
	private emailVerificationRequired(pool: UserPoolRow): boolean {
		if (pool.signup_mode === 'invite') return true;
		return (
			this.ctx.sqlite
				.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
				.get(userPoolRequireEmailVerificationKey(pool.id))?.value === '1'
		);
	}

	/** Rolling-window limiter, keyed by address or client IP. Mirrors the hosted pages' helper. */
	private allowRequest(key: string, limit: number): boolean {
		const now = this.ctx.now();
		const windowMs = USER_POOL_REQUEST_WINDOW_SECONDS * 1000;
		const recent = (this.requestWindow.get(key) ?? []).filter((at) => now - at < windowMs);
		if (recent.length >= limit) {
			this.requestWindow.set(key, recent);
			return false;
		}
		recent.push(now);
		this.requestWindow.delete(key);
		this.requestWindow.set(key, recent);
		if (this.requestWindow.size > 10_000) {
			for (const [entry, times] of this.requestWindow)
				if (times.every((at) => now - at >= windowMs)) this.requestWindow.delete(entry);
		}
		return true;
	}

	/**
	 * Store a fresh single-use token for one purpose. Any earlier unused token for the same purpose
	 * is voided, so only the newest link in a mailbox works and a reset cannot be replayed.
	 */
	private issueEmailToken(
		poolId: string,
		userId: string,
		purpose: EmailTokenPurpose,
		now = this.ctx.now()
	): { token: string; expiresAt: number } {
		this.requireUser(poolId, userId);
		const token = randomToken(32);
		const expiresAt = now + EMAIL_TOKEN_TTL[purpose] * 1000;
		this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run(
				`UPDATE user_pool_email_tokens SET used_at = ?
				  WHERE pool_id = ? AND user_id = ? AND purpose = ? AND used_at IS NULL`,
				[now, poolId, userId, purpose]
			);
			this.ctx.sqlite.run(
				`INSERT INTO user_pool_email_tokens (token_hash, pool_id, user_id, purpose, created_at, expires_at, used_at)
				 VALUES (?, ?, ?, ?, ?, ?, NULL)`,
				[sha256Hex(token), poolId, userId, purpose, now, expiresAt]
			);
		})();
		return { token, expiresAt };
	}

	/**
	 * Check and single-use a token. The same refusal answers unknown, expired, already used and
	 * disabled-account tokens, and the update is conditional so two concurrent clicks cannot both
	 * win.
	 */
	private consumeEmailToken(poolId: string, token: string, purpose: EmailTokenPurpose): UserRow {
		const refusal = new ValidationError('That link is invalid or has expired.');
		if (!token) throw refusal;
		const now = this.ctx.now();
		const row = this.ctx.sqlite
			.query<EmailTokenRow, [string, string, string]>(
				`SELECT * FROM user_pool_email_tokens
				  WHERE token_hash = ? AND pool_id = ? AND purpose = ?`
			)
			.get(sha256Hex(token), poolId, purpose);
		if (!row || row.used_at !== null || row.expires_at <= now) throw refusal;
		const user = this.ctx.sqlite
			.query<UserRow, [string, string]>('SELECT * FROM user_pool_users WHERE id = ? AND pool_id = ?')
			.get(row.user_id, poolId);
		if (!user || user.disabled_at !== null) throw refusal;
		const used = this.ctx.sqlite.run(
			'UPDATE user_pool_email_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL',
			[now, row.token_hash]
		);
		if (used.changes === 0) throw refusal;
		return user;
	}

	private async sendLinkMail(
		pool: UserPoolRow,
		user: UserRow,
		purpose: Exclude<UserPoolMailPurpose, 'invite'>,
		token: string
	): Promise<void> {		const link = this.poolLink(pool.id, purpose, token);
		const ttlMinutes = Math.round(EMAIL_TOKEN_TTL[purpose] / 60);
		const copy: Record<
			Exclude<UserPoolMailPurpose, 'invite'>,
			{ subject: string; intro: string }
		> = {
			verify_email: {
				subject: `Verify your email for ${pool.name}`,
				intro: `Confirm that this address belongs to your ${pool.name} account.`
			},
			magic_link: {
				subject: `Sign in to ${pool.name}`,
				intro: `Use this link to sign in to ${pool.name}.`
			},
			password_reset: {
				subject: `Reset your ${pool.name} password`,
				intro: `Someone asked to reset the password for this ${pool.name} account. If that was not you, ignore this mail.`
			}
		};
		await this.sendMail({
			orgId: pool.org_id,
			poolId: pool.id,
			poolName: pool.name,
			to: user.email,
			purpose,
			subject: copy[purpose].subject,
			text: [
				copy[purpose].intro,
				'',
				link,
				'',
				`This link can be used once and expires in ${ttlMinutes} minutes.`
			].join('\n'),
			link
		});
	}

	private async sendInviteMail(
		pool: UserPoolRow,
		email: string,
		token: string,
		expiresAt: number
	): Promise<void> {
		const link = this.poolLink(pool.id, 'invite', token);
		await this.sendMail({
			orgId: pool.org_id,
			poolId: pool.id,
			poolName: pool.name,
			to: email,
			purpose: 'invite',
			subject: `You're invited to ${pool.name}`,
			text: [
				`You have been invited to join ${pool.name}.`,
				'',
				link,
				'',
				`This invitation expires ${new Date(expiresAt).toISOString()}.`
			].join('\n'),
			link
		});
	}

	private poolLink(
		poolId: string,
		purpose: UserPoolMailPurpose,
		token: string
	): string {
		const origin = this.ctx.config.platformOrigin.replace(/\/+$/, '');
		const path =
			purpose === 'verify_email'
				? 'verify'
				: purpose === 'magic_link'
					? 'magic'
					: purpose === 'password_reset'
						? 'reset'
						: 'signup';
		const parameter = purpose === 'invite' ? 'invite' : 'token';
		return `${origin}/pool/${poolId}/${path}?${parameter}=${encodeURIComponent(token)}`;
	}

	/**
	 * Mail failures never fail a sign-up or a request: an unknown address, a suppressed recipient
	 * and a mail outage must look identical to the caller. The log line carries ids only, never a
	 * link or token.
	 */
	private async sendMail(message: UserPoolMailMessage): Promise<void> {
		try {
			await this.ctx.userPoolMail?.send(message);
		} catch (error) {
			// Name only: an SMTP or serialiser message can quote the body, which carries the link.
			console.error(
				`[user-pool] ${message.purpose} mail for pool ${message.poolId} could not be sent (${
					error instanceof Error ? error.name : 'unknown error'
				}).`
			);
		}
	}

	private passkeyRows(poolId: string, userId: string): UserPoolPasskeyRow[] {
		return this.ctx.sqlite
			.query<UserPoolPasskeyRow, [string, string]>(
				'SELECT * FROM user_pool_passkeys WHERE pool_id = ? AND user_id = ? ORDER BY created_at DESC'
			)
			.all(poolId, userId);
	}

	private requirePasskey(poolId: string, userId: string, passkeyId: string): UserPoolPasskeyRow {
		const row = this.ctx.sqlite
			.query<UserPoolPasskeyRow, [string, string, string]>(
				'SELECT * FROM user_pool_passkeys WHERE id = ? AND pool_id = ? AND user_id = ?'
			)
			.get(passkeyId, poolId, userId);
		if (!row) throw new NotFoundError('Passkey');
		return row;
	}

	private totpRow(poolId: string, userId: string): UserPoolTotpRow | null {
		return (
			this.ctx.sqlite
				.query<UserPoolTotpRow, [string, string]>(
					'SELECT * FROM user_pool_totp WHERE pool_id = ? AND user_id = ?'
				)
				.get(poolId, userId) ?? null
		);
	}

	private totpEnabled(poolId: string, userId: string): boolean {
		const row = this.totpRow(poolId, userId);
		return row !== null && row.confirmed_at !== null;
	}

	/** Drop pending second-factor challenges for a disabled or deleted user (all users when omitted). */
	private forgetMfaChallenges(poolId: string, userId?: string): void {
		for (const [token, entry] of this.mfaChallenges)
			if (entry.poolId === poolId && (userId === undefined || entry.userId === userId))
				this.mfaChallenges.delete(token);
	}

	/** Store a one-time MFA challenge and return its raw token. Expired entries are swept here. */
	private issueMfaChallenge(poolId: string, userId: string): { token: string; expiresAt: number } {		const now = this.ctx.now();
		for (const [token, entry] of this.mfaChallenges)
			if (entry.expiresAt <= now) this.mfaChallenges.delete(token);
		while (this.mfaChallenges.size >= USER_POOL_MFA_CHALLENGE_CAP) {
			const oldest = this.mfaChallenges.keys().next().value;
			if (oldest === undefined) break;
			this.mfaChallenges.delete(oldest);
		}
		const token = randomToken(32);
		const expiresAt = now + USER_POOL_MFA_CHALLENGE_TTL_SECONDS * 1000;
		this.mfaChallenges.set(token, { poolId, userId, expiresAt, attempts: 0 });
		return { token, expiresAt };
	}

	/**
	 * Check a TOTP code or an unused recovery code. A TOTP step must strictly advance, and the
	 * conditional update means a concurrent request cannot accept the same step twice. A recovery
	 * code is consumed inside a transaction so two requests cannot both spend it.
	 */
	private verifyMfaCode(
		pool: UserPoolRow,
		userId: string,
		code: string
	): { ok: boolean; usedRecoveryCode: boolean } {
		const row = this.totpRow(pool.id, userId);
		if (!row || row.confirmed_at === null) return { ok: false, usedRecoveryCode: false };
		try {
			const secret = this.ctx.secrets.open(pool.org_id, row.secret_sealed);
			const step = verifyUserPoolTotp(secret, code, this.ctx.now());
			if (step !== null) {
				if (row.last_step !== null && step <= row.last_step)
					return { ok: false, usedRecoveryCode: false };
				const updated = this.ctx.sqlite.run(
					`UPDATE user_pool_totp SET last_step = ?
					  WHERE pool_id = ? AND user_id = ? AND confirmed_at IS NOT NULL
					    AND (last_step IS NULL OR last_step < ?)`,
					[step, pool.id, userId, step]
				);
				return { ok: updated.changes > 0, usedRecoveryCode: false };
			}
		} catch {
			// A corrupted sealed secret fails closed rather than surfacing a decryption message.
			return { ok: false, usedRecoveryCode: false };
		}

		const normalized = normalizeRecoveryCode(code);
		if (!normalized) return { ok: false, usedRecoveryCode: false };
		const hash = recoveryCodeHash(code);
		const consumed = this.ctx.sqlite.transaction(() => {
			const fresh = this.totpRow(pool.id, userId);
			if (!fresh || fresh.confirmed_at === null) return false;
			const entries = parseRecoveryCodes(fresh.recovery_codes_json);
			const match = entries.find((entry) => entry.usedAt === null && safeEqual(entry.hash, hash));
			if (!match) return false;
			match.usedAt = this.ctx.now();
			const updated = this.ctx.sqlite.run(
				'UPDATE user_pool_totp SET recovery_codes_json = ? WHERE pool_id = ? AND user_id = ?',
				[JSON.stringify(entries), pool.id, userId]
			);
			return updated.changes > 0;
		})();
		return { ok: consumed, usedRecoveryCode: consumed };
	}

	private requireGroup(poolId: string, groupId: string): UserPoolGroupRow {
		const row = this.ctx.sqlite
			.query<UserPoolGroupRow, [string, string]>(
				`SELECT g.id, g.pool_id, g.name, g.created_at,
				        (SELECT COUNT(*) FROM user_pool_group_members m WHERE m.group_id = g.id) AS member_count
				   FROM user_pool_groups g
				  WHERE g.id = ? AND g.pool_id = ?`
			)
			.get(groupId, poolId);
		if (!row) throw new NotFoundError('User pool group');
		return row;
	}

	/** Store a one-time challenge and return its opaque id. Expired entries are swept opportunistically. */
	private issuePasskeyChallenge(
		record: Omit<PasskeyChallengeRecord, 'expiresAt'> & { expiresAt?: number }
	): { challengeId: string; expiresAt: number } {
		const now = this.ctx.now();
		for (const [id, entry] of this.passkeyChallenges)
			if (entry.expiresAt <= now) this.passkeyChallenges.delete(id);
		// Bounded memory: drop the oldest outstanding challenge rather than grow without limit.
		while (this.passkeyChallenges.size >= USER_POOL_PASSKEY_CHALLENGE_CAP) {
			const oldest = this.passkeyChallenges.keys().next().value;
			if (oldest === undefined) break;
			this.passkeyChallenges.delete(oldest);
		}
		const challengeId = randomToken(24);
		const expiresAt = record.expiresAt ?? now + USER_POOL_PASSKEY_CHALLENGE_TTL_SECONDS * 1000;
		this.passkeyChallenges.set(challengeId, { ...record, expiresAt });
		return { challengeId, expiresAt };
	}

	/**
	 * Consume a challenge exactly once. Unknown, wrong-pool, wrong-type, reused and expired ids all
	 * answer with the same refusal, so a caller cannot tell them apart.
	 */
	private consumePasskeyChallenge(
		poolId: string,
		challengeId: string,
		type: PasskeyChallengeRecord['type']
	): PasskeyChallengeRecord {
		const refusal = new UnauthorizedError('Passkey verification failed.');
		const record = challengeId ? this.passkeyChallenges.get(challengeId) : undefined;
		if (!record || record.poolId !== poolId || record.type !== type) throw refusal;
		this.passkeyChallenges.delete(challengeId);
		if (record.expiresAt <= this.ctx.now()) throw refusal;
		return record;
	}

	private async webAuthnGeneration<T>(run: (provider: UserPoolWebAuthnProvider) => Promise<T>): Promise<T> {
		const provider = webAuthnProvider();
		try {
			return await run(provider);
		} catch (error) {
			if (error instanceof CoreError) throw error;
			throw new CoreError('passkey_unavailable', 'Passkeys are not available on this server.', 503);
		}
	}

	/** Any library refusal, malformed response or bad signature is one generic unauthorized answer. */
	private async webAuthnVerification<T>(
		run: (provider: UserPoolWebAuthnProvider) => Promise<T>,
		message = 'Passkey verification failed.'
	): Promise<T> {
		const provider = webAuthnProvider();
		try {
			return await run(provider);
		} catch {
			throw new UnauthorizedError(message);
		}
	}

	private requirePool(poolId: string): UserPoolRow {
		const row = this.ctx.sqlite
			.query<UserPoolRow, [string]>(
				'SELECT id, org_id, name, issuer, signup_mode, theme_json, disabled_at FROM user_pools WHERE id = ?'
			)
			.get(poolId);
		if (!row) throw new NotFoundError('User pool');
		return row;
	}

	private requireEnabledPool(poolId: string): UserPoolRow {
		const row = this.requirePool(poolId);
		if (row.disabled_at !== null) throw new NotFoundError('User pool');
		return row;
	}

	private requireClient(poolId: string, clientId: string): ClientRow {
		const row = this.ctx.sqlite
			.query<ClientRow, [string, string]>(
				'SELECT * FROM user_pool_clients WHERE pool_id = ? AND client_id = ?'
			)
			.get(poolId, clientId);
		if (!row) throw new NotFoundError('User pool client');
		return row;
	}

	private requireUser(poolId: string, userId: string): UserRow {
		const row = this.ctx.sqlite
			.query<UserRow, [string, string]>('SELECT * FROM user_pool_users WHERE id = ? AND pool_id = ?')
			.get(userId, poolId);
		if (!row) throw new NotFoundError('User pool user');
		return row;
	}
}

/**
 * The production mail path (see `docs/EMAIL.md`): the platform's transactional SMTP sender (D22)
 * first, so sign-in links still work when the mail node is down, then the platform sender on a mail
 * node (skiff-mail outbox). With neither, only a development process logs the link; a production
 * process refuses without putting the token anywhere. A future public `sendPlatformMail` on
 * `EmailService` replaces the structural call to its current private queue method.
 */
interface SkiffMailPlatformSender {
	settings(): { nodeId: string | null };
	queuePlatformMail?(
		orgId: string,
		message: { to: string; subject: string; text: string },
		tags: Record<string, string>
	): Promise<string>;
}

export function createUserPoolMailer(ctx: CoreContext): UserPoolMailer {
	return {
		async send(message) {
			const transport = ctx.config.email;
			if (transport) {
				try {
					await transport.send({ to: message.to, subject: message.subject, text: message.text });
					return;
				} catch {
					// Fall through to the mail node; the caller only sees a generic failure.
				}
			}
			const email = ctx.email as unknown as SkiffMailPlatformSender | undefined;
			if (email?.settings().nodeId && typeof email.queuePlatformMail === 'function') {
				await email.queuePlatformMail(
					message.orgId,
					{ to: message.to, subject: message.subject, text: message.text },
					{ skiff: `user-pool-${message.purpose}` }
				);
				return;
			}
			// Documented development fallback: the only place a pool link is ever logged.
			if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
				console.info(
					`[user-pool:dev] ${message.purpose} mail for ${message.poolName} to ${message.to}: ${message.link}`
				);
				return;
			}
			throw new CoreError(
				'platform_mail_unavailable',
				'Skiff has no mail path for pool email: configure SKIFF_SMTP_* or a mail node.',
				409
			);
		}
	};
}

function userView(row: UserRow): UserPoolUserView {
	const metadata = parseJson<unknown>(row.metadata_json, {});
	return {
		id: row.id,
		poolId: row.pool_id,
		email: row.email,
		name: row.name,
		emailVerified: row.email_verified_at !== null,
		disabled: row.disabled_at !== null,
		metadata:
			metadata && typeof metadata === 'object' && !Array.isArray(metadata)
				? (metadata as Record<string, unknown>)
				: {},
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function sessionView(row: SessionRow): UserPoolSessionView {
	return {
		id: row.id,
		poolId: row.pool_id,
		userId: row.user_id,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		lastSeenAt: row.last_seen_at,
		revokedAt: row.revoked_at
	};
}

function inviteView(row: InviteRow): UserPoolInviteView {
	return {
		id: row.id,
		poolId: row.pool_id,
		email: row.email,
		createdBy: row.created_by,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		usedAt: row.used_at
	};
}

function parseRedirectUris(client: ClientRow): string[] {
	const value = parseJson<unknown>(client.redirect_uris_json, []);
	return Array.isArray(value) ? value.filter((uri): uri is string => typeof uri === 'string') : [];
}

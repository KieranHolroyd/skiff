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
 * TODO(I27): passkeys, social login, TOTP MFA, breached-password checks, lockout, suspicious
 * sign-in mail, import/export and the identity process remain for a later slice.
 */
import { createHash } from 'node:crypto';
import type { CoreContext } from './context.ts';
import {
	ConflictError,
	CoreError,
	ForbiddenError,
	NotFoundError,
	UnauthorizedError,
	ValidationError
} from './errors.ts';
import { newId, parseJson, randomToken, safeEqual, sha256Hex } from './util.ts';
import {
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

/** Request throttles, per address and per client IP, over one rolling window. */
export const USER_POOL_REQUEST_WINDOW_SECONDS = 15 * 60;
export const USER_POOL_MAGIC_EMAIL_LIMIT = 5;
export const USER_POOL_RESET_EMAIL_LIMIT = 3;
export const USER_POOL_VERIFY_EMAIL_LIMIT = 3;
export const USER_POOL_REQUEST_IP_LIMIT = 20;

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

export class UserPoolEngineService {
	/** Per-instance rolling windows for the enumeration-safe request endpoints. */
	private readonly requestWindow = new Map<string, number[]>();

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

	/** Insert a session row and emit the D122 event; shared by password, magic-link and reset sign-in. */
	private startSession(
		pool: UserPoolRow,
		user: UserRow,
		method: 'password' | 'magic_link' | 'password_reset'
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
			emailVerificationPending: user.email_verified_at === null
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
			this.ctx.sqlite.run('DELETE FROM user_pool_users WHERE id = ? AND pool_id = ?', [user.id, poolId]);
		})();
		return true;
	}

	/** Remove every engine row for a pool; called from `UserPoolService.delete` inside its transaction. */
	purgePool(poolId: string): void {
		this.ctx.sqlite.run('DELETE FROM user_pool_codes WHERE pool_id = ?', [poolId]);
		this.ctx.sqlite.run('DELETE FROM user_pool_sessions WHERE pool_id = ?', [poolId]);
		this.ctx.sqlite.run('DELETE FROM user_pool_email_tokens WHERE pool_id = ?', [poolId]);
		this.ctx.sqlite.run('DELETE FROM user_pool_invites WHERE pool_id = ?', [poolId]);
		this.ctx.sqlite.run('DELETE FROM user_pool_users WHERE pool_id = ?', [poolId]);
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
		const purpose = userPoolSigningPurpose(pool.id);

		const idToken = await this.ctx.signingKeys.sign(
			purpose,
			{
				sub: user.id,
				aud: client.client_id,
				...(row.nonce ? { nonce: row.nonce } : {}),
				...(withEmail ? { email: user.email, email_verified: user.email_verified_at !== null } : {}),
				...(withProfile ? { name: user.name } : {})
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
				...(withProfile ? { name: user.name } : {})
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
			...(scopes.has('profile') ? { name: user.name } : {})
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
	): Promise<void> {
		const link = this.poolLink(pool.id, purpose, token);
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

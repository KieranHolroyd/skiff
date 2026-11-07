/**
 * Owner second-factor policy (D10, DESIGN §6.1). Pure functions only, so the rules are unit-tested
 * without a database; `second-factor.ts` wires them to Better Auth and SQLite.
 *
 * The policy:
 * - An org **owner's** browser session may use the platform only once the session has proved a
 *   second factor: it was established with a **passkey**, or the owner verified a **TOTP code** (or
 *   a backup code) in this session. GitHub and magic-link sign-ins are single-factor; Better Auth's
 *   twoFactor plugin only intercepts credential (password) sign-in, so Skiff records the factor on
 *   the session itself (`session.secondFactor`) and enforces it here.
 * - An owner with **no factor enrolled yet** is sent to enrol (add a passkey or set up an
 *   authenticator app). Completing enrolment in the session satisfies it.
 * - An owner who **already has a factor** must verify it; enrolling a new factor (or changing
 *   existing ones) from an unproven session is refused, so a hijacked GitHub account or mailbox
 *   cannot simply register its own passkey.
 * - Other roles are unaffected. API keys and MCP tokens are unaffected too: minting them (API key
 *   creation, CLI approval, OAuth consent) needs a satisfied session in the first place.
 */

import type { Principal, Role } from '@skiff/contracts';
import { safeRedirect } from '../redirect';

export type SecondFactor = 'passkey' | 'totp' | 'backup-code';

export type SecondFactorState =
	/** Nothing to do: not an owner, enforcement off, or the session already proved a factor. */
	| 'satisfied'
	/** Owner with an enrolled factor who has not used it in this session. */
	| 'challenge'
	/** Owner with no factor at all: must enrol one. */
	| 'enrol';

export function secondFactorState(input: {
	enforce: boolean;
	role: Role | undefined;
	kind: Principal['kind'] | undefined;
	sessionFactor: string | null | undefined;
	hasFactor: boolean;
}): SecondFactorState {
	if (!input.enforce || input.kind !== 'user' || input.role !== 'owner') return 'satisfied';
	if (input.sessionFactor) return 'satisfied';
	return input.hasFactor ? 'challenge' : 'enrol';
}

/**
 * Paths an owner may reach before satisfying the second factor: the challenge/enrol page itself,
 * Better Auth (gated endpoint-by-endpoint by `authPathAllowedBeforeSecondFactor`), sign-in, assets,
 * and bearer-authenticated machine endpoints that never use the session.
 */
// `/setup` walks a brand-new owner through enrolment itself (D102). Password reset never signs in
// (it signs every session out), so the owner still proves a factor at the next sign-in.
const EXEMPT_EXACT = new Set([
	'/two-factor',
	'/login',
	'/setup',
	'/forgot-password',
	'/reset-password',
	'/favicon.ico',
	'/favicon.svg',
	'/robots.txt',
	'/mcp',
]);
const EXEMPT_PREFIXES = ['/two-factor/', '/api/auth/', '/_app/', '/.well-known/', '/api/agent/', '/api/objects/'];

export function isExemptBeforeSecondFactor(pathname: string): boolean {
	return EXEMPT_EXACT.has(pathname) || EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** Better Auth endpoints that are always fine for an unproven owner session (sign in/out, verify). */
const AUTH_ALWAYS = new Set([
	'/get-session',
	'/sign-out',
	'/passkey/generate-authenticate-options',
	'/passkey/verify-authentication',
	'/two-factor/verify-totp',
	'/two-factor/verify-backup-code',
	'/magic-link/verify',
	// Password reset: emails a link, or sets a new password and signs every session out.
	'/request-password-reset',
	'/reset-password',
	'/ok',
	'/error',
	// Client-authenticated OAuth endpoints: they never act on the browser session.
	'/oauth2/token',
	'/oauth2/register',
	'/oauth2/revoke',
	'/oauth2/introspect',
	'/oauth2/userinfo',
	'/oauth2/end-session',
	'/oauth2/public-client',
	'/oauth2/public-client-prelogin',
	'/jwks',
]);
const AUTH_ALWAYS_PREFIXES = ['/sign-in/', '/callback/', '/oauth2/callback/', '/reset-password/'];
/** Enrolment endpoints: only while the owner has no factor yet. */
const AUTH_ENROL = new Set([
	'/passkey/generate-register-options',
	'/passkey/verify-registration',
	'/passkey/list-user-passkeys',
	'/two-factor/enable',
]);

/**
 * Whether an unproven owner session may call a Better Auth endpoint (`path` is relative to
 * `/api/auth`). Everything else (API keys, organization changes, OAuth consent/authorize, factor
 * removal) waits for the second factor.
 */
export function authPathAllowedBeforeSecondFactor(path: string, hasFactor: boolean): boolean {
	if (AUTH_ALWAYS.has(path) || AUTH_ALWAYS_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
	return !hasFactor && AUTH_ENROL.has(path);
}

/** OAuth authorization (MCP clients) resumes here after the challenge instead of failing. */
export const OAUTH_AUTHORIZE_PATH = '/oauth2/authorize';
const RESUMABLE = ['/api/auth/oauth2/authorize'];

/** The factor a successful Better Auth call proves, if any. */
export function factorProvedBy(path: string): SecondFactor | undefined {
	switch (path) {
		case '/passkey/verify-authentication':
		case '/passkey/verify-registration':
			return 'passkey';
		case '/two-factor/verify-totp':
			return 'totp';
		case '/two-factor/verify-backup-code':
			return 'backup-code';
		default:
			return undefined;
	}
}

/** Failed TOTP/backup-code attempts allowed in one unproven session before it is revoked. */
export const MAX_SECOND_FACTOR_FAILURES = 5;

/** Same-origin path to continue to after the challenge (anything else falls back to `/overview`). */
export function continueTo(raw: string | null | undefined, origin: string): string {
	const path = safeRedirect(raw, origin, '/overview');
	// Never bounce back into the challenge, sign-in or auth API.
	const pathname = path.split(/[?#]/)[0]!;
	if (RESUMABLE.includes(pathname)) return path;
	if (path === '/' || isExemptBeforeSecondFactor(pathname)) return '/overview';
	return path;
}

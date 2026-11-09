import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sqlite } from './db';

/**
 * Browser login for the CLI (`yoal login --web`).
 *
 * The CLI generates a PKCE verifier and a random state, then opens `<platform>/cli/login`.
 * After dashboard sign-in, the user approves the request and the control plane redirects a
 * one-time code to the CLI's loopback listener. The CLI posts the code and verifier to
 * `/api/v1/cli/token`, which mints a regular API key (`yoal_…`) for the REST API.
 */

export const CLI_LOGIN_CODE_TTL_MS = 5 * 60_000;

export interface CliLoginRequest {
	redirectUri: string;
	state: string;
	codeChallenge: string;
}

export type CliLoginRequestResult =
	| { ok: true; request: CliLoginRequest }
	| { ok: false; message: string };

const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function parseCliLoginRequest(params: URLSearchParams): CliLoginRequestResult {
	const redirectUri = params.get('redirect_uri')?.trim() ?? '';
	const state = params.get('state')?.trim() ?? '';
	const codeChallenge = params.get('code_challenge')?.trim() ?? '';
	const method = params.get('code_challenge_method') ?? 'S256';

	if (method !== 'S256')
		return { ok: false, message: 'Only PKCE with code_challenge_method=S256 is supported.' };
	if (!STATE_PATTERN.test(state))
		return { ok: false, message: 'The login request has a missing or invalid state.' };
	if (!CHALLENGE_PATTERN.test(codeChallenge))
		return { ok: false, message: 'The login request has a missing or invalid code challenge.' };

	const redirectError = validateRedirectUri(redirectUri);
	if (redirectError) return { ok: false, message: redirectError };

	return { ok: true, request: { redirectUri, state, codeChallenge } };
}

/** Only loopback callbacks on `/callback` are accepted, so the page cannot become an open redirect. */
function validateRedirectUri(raw: string): string | null {
	if (!raw || raw.length > 2048) return 'The login request has a missing or invalid redirect URI.';
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return 'The login request has an invalid redirect URI.';
	}
	if (url.protocol !== 'http:') return 'The CLI redirect URI must use http on loopback.';
	if (!LOOPBACK_HOSTS.has(url.hostname))
		return 'The CLI redirect URI must point at 127.0.0.1, localhost or ::1.';
	if (url.pathname !== '/callback') return 'The CLI redirect URI path must be /callback.';
	if (url.username || url.password) return 'The CLI redirect URI must not contain credentials.';
	if (url.search || url.hash) return 'The CLI redirect URI must not contain a query or fragment.';
	if (!url.port) return 'The CLI redirect URI must include its loopback port.';
	return null;
}

export function createCliLoginCode(input: {
	userId: string;
	redirectUri: string;
	codeChallenge: string;
}): string {
	const code = randomBytes(32).toString('base64url');
	const now = Date.now();
	sqlite.run('DELETE FROM cli_login_codes WHERE expires_at < ?', [now]);
	sqlite.run(
		`INSERT INTO cli_login_codes
			(code_hash, user_id, redirect_uri, code_challenge, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[hashToken(code), input.userId, input.redirectUri, input.codeChallenge, now + CLI_LOGIN_CODE_TTL_MS, now],
	);
	return code;
}

export type RedeemCliLoginCodeResult =
	| { ok: true; userId: string }
	| { ok: false; reason: 'invalid' | 'expired' };

export function redeemCliLoginCode(code: string, codeVerifier: string): RedeemCliLoginCodeResult {
	const hash = hashToken(code);
	const row = sqlite
		.query<
			{
				user_id: string;
				code_challenge: string;
				expires_at: number;
				used_at: number | null;
			},
			[string]
		>('SELECT user_id, code_challenge, expires_at, used_at FROM cli_login_codes WHERE code_hash = ?')
		.get(hash);

	if (!row || row.used_at !== null) return { ok: false, reason: 'invalid' };
	if (row.expires_at <= Date.now()) {
		sqlite.run('DELETE FROM cli_login_codes WHERE code_hash = ?', [hash]);
		return { ok: false, reason: 'expired' };
	}
	if (!safeEqual(hashToken(codeVerifier), row.code_challenge)) return { ok: false, reason: 'invalid' };

	const now = Date.now();
	const used = sqlite.run(
		'UPDATE cli_login_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL',
		[now, hash],
	);
	if (used.changes !== 1) return { ok: false, reason: 'invalid' };
	return { ok: true, userId: row.user_id };
}

/** Append `params` to the validated loopback redirect URI. */
export function cliLoginCallbackUrl(
	redirectUri: string,
	params: Record<string, string>,
): string {
	const url = new URL(redirectUri);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	return url.toString();
}

function hashToken(value: string): string {
	return createHash('sha256').update(value).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

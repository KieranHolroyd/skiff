/**
 * Pure HTTP helpers for the identity process. Path parsing, cookie shape, CSRF, rate limiting and
 * small form helpers live here so they can be tested without a database or a listening socket.
 */

export const SESSION_COOKIE = 'skiff_pool_session';
export const CSRF_COOKIE = 'skiff_pool_csrf';

export type OAuthAction = 'authorize' | 'token' | 'userinfo' | 'logout';
export type HostedPage = 'login' | 'signup' | 'verify' | 'reset' | 'magic' | 'logout' | 'mfa' | 'otp' | 'account';
export type PasskeyAction =
	| 'login-options'
	| 'login-verify'
	| 'register-options'
	| 'register-verify';

export type IdentityRoute =
	| { kind: 'health' }
	| { kind: 'ready' }
	| { kind: 'metrics' }
	| { kind: 'discovery'; poolId: string }
	| { kind: 'jwks'; poolId: string }
	| { kind: 'oauth'; poolId: string; action: OAuthAction }
	| { kind: 'page'; poolId: string; page: HostedPage }
	| { kind: 'passkey'; poolId: string; action: PasskeyAction }
	| { kind: 'socialCallback'; poolId: string; provider: string }
	| { kind: 'unknown' };

const POOL = '[A-Za-z0-9_-]{1,128}';
const PROVIDER = '[A-Za-z0-9_-]{1,40}';
const LEGACY = new RegExp(`^/pool/(${POOL})(?:/(.*))?$`);
const DIRECT = new RegExp(`^/(${POOL})(?:/(.*))?$`);
/** The engine builds social callbacks against `platformOrigin`, which is the issuer in this process. */
const ENGINE_CALLBACK = new RegExp(`^/api/v1/user-pools/(${POOL})/oauth/callback/(${PROVIDER})$`);

function page(value: string | undefined): HostedPage | null {
	if (!value) return 'login';
	if (
		value === 'login' ||
		value === 'signup' ||
		value === 'verify' ||
		value === 'reset' ||
		value === 'magic' ||
		value === 'logout' ||
		value === 'mfa' ||
		value === 'otp' ||
		value === 'account'
	)
		return value;
	return null;
}

function passkey(value: string | undefined): PasskeyAction | null {
	const action = value?.replaceAll('/', '-');
	if (
		action === 'login-options' ||
		action === 'login-verify' ||
		action === 'register-options' ||
		action === 'register-verify'
	)
		return action;
	return null;
}

/** Parse an issuer-shaped path (`/<pool>/…` or the engine's mail-link `/pool/<pool>/…`). */
export function parseIdentityPath(pathname: string): IdentityRoute {
	if (pathname === '/healthz' || pathname === '/health') return { kind: 'health' };
	if (pathname === '/readyz' || pathname === '/ready') return { kind: 'ready' };
	if (pathname === '/metrics') return { kind: 'metrics' };
	const engineCallback = ENGINE_CALLBACK.exec(pathname);
	if (engineCallback) return { kind: 'socialCallback', poolId: engineCallback[1]!, provider: engineCallback[2]! };
	const match = LEGACY.exec(pathname) ?? DIRECT.exec(pathname);
	if (!match) return { kind: 'unknown' };
	const poolId = match[1]!;
	const rest = (match[2] ?? '').replace(/\/+$/, '');
	if (rest === '.well-known/openid-configuration') return { kind: 'discovery', poolId };
	if (rest === '.well-known/jwks.json') return { kind: 'jwks', poolId };
	if (rest.startsWith('oauth2/')) {
		const action = rest.slice('oauth2/'.length) as OAuthAction;
		if (action === 'authorize' || action === 'token' || action === 'userinfo' || action === 'logout')
			return { kind: 'oauth', poolId, action };
		return { kind: 'unknown' };
	}
	const social = new RegExp(`^oauth/callback/(${PROVIDER})$`).exec(rest);
	if (social) return { kind: 'socialCallback', poolId, provider: social[1]! };
	if (rest.startsWith('passkeys/')) {
		const action = passkey(rest.slice('passkeys/'.length));
		return action ? { kind: 'passkey', poolId, action } : { kind: 'unknown' };
	}
	const hosted = page(rest);
	return hosted ? { kind: 'page', poolId, page: hosted } : { kind: 'unknown' };
}

/** A cookie's value from a `Cookie:` header. */
export function cookieValue(header: string | null | undefined, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(';')) {
		const index = part.indexOf('=');
		if (index < 0) continue;
		if (part.slice(0, index).trim() !== name) continue;
		try {
			return decodeURIComponent(part.slice(index + 1).trim());
		} catch {
			return part.slice(index + 1).trim();
		}
	}
	return null;
}

/**
 * A pool session cookie is scoped to the pool's issuer path on the shared `auth.<sitesDomain>`
 * host, so two pools never share a session.
 */
export function sessionCookie(poolId: string, token: string, secure: boolean): string {
	return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/${poolId}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(poolId: string, secure: boolean): string {
	return `${SESSION_COOKIE}=; Path=/${poolId}; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** Double-submit CSRF token, scoped and short-lived like the control-plane hosted pages. */
export function csrfCookie(poolId: string, token: string, secure: boolean): string {
	return `${CSRF_COOKIE}=${encodeURIComponent(token)}; Path=/${poolId}; HttpOnly; SameSite=Lax; Max-Age=900${secure ? '; Secure' : ''}`;
}

/** Only a same-site path, or an absolute URL on this issuer host, is a safe return target. */
export function safeReturnTo(
	value: string | null | undefined,
	fallback = '/',
	origin?: string,
): string {
	if (!value) return fallback;
	if (/^https?:\/\//i.test(value)) {
		try {
			const candidate = new URL(value);
			return origin && candidate.origin === origin ? candidate.toString() : fallback;
		} catch {
			return fallback;
		}
	}
	if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
	return value;
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export interface PageTheme {
	displayName?: string;
	primaryColor?: string;
	backgroundColor?: string;
	logoUrl?: string;
	copy?: string;
}

function themeValue(theme: Record<string, unknown>, key: keyof PageTheme): string | null {
	const value = theme[key];
	return typeof value === 'string' ? value : null;
}

/** Theme colours are CSS values: accept only hex, so a pool cannot inject extra rules. */
function themeColor(theme: Record<string, unknown>, key: 'primaryColor' | 'backgroundColor', fallback: string): string {
	const value = themeValue(theme, key);
	return value && /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback;
}

/** The display name a pool chose, falling back to its row name. */
export function poolDisplayName(name: string, theme: Record<string, unknown> = {}): string {
	return themeValue(theme, 'displayName') || name;
}

/** A minimal, dependency-free hosted page. Copy is fixed; only the theme colours, logo and copy vary. */
export function renderPage(options: {
	poolName: string;
	title: string;
	body: string;
	theme?: Record<string, unknown>;
	status?: number;
	headers?: Record<string, string>;
}): Response {
	const theme = options.theme ?? {};
	const primary = themeColor(theme, 'primaryColor', '#111827');
	const background = themeColor(theme, 'backgroundColor', '#f9fafb');
	const logo = themeValue(theme, 'logoUrl');
	const safeLogo = logo && /^https:\/\//.test(logo) ? logo : null;
	const displayName = poolDisplayName(options.poolName, theme);
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)} · ${escapeHtml(displayName)}</title>
<style>
:root { color-scheme: light; --pool-primary: ${escapeHtml(primary)}; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: ${escapeHtml(background)}; font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; color: #111827; }
main { width: min(380px, calc(100vw - 32px)); padding: 28px; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; box-shadow: 0 10px 30px rgb(0 0 0 / 6%); }
h1 { margin: 0 0 4px; font-size: 20px; }
p { margin: 0 0 18px; color: #4b5563; }
label { display: block; margin: 12px 0 4px; font-weight: 600; font-size: 13px; }
input { box-sizing: border-box; width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font: inherit; }
button { width: 100%; margin-top: 18px; padding: 10px 12px; border: 0; border-radius: 8px; background: ${escapeHtml(primary)}; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
button.secondary { background: #fff; color: #111827; border: 1px solid #d1d5db; }
nav { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 18px; font-size: 13px; }
a { color: ${escapeHtml(primary)}; }
img { max-height: 48px; margin-bottom: 16px; }
.error { color: #b91c1c; font-weight: 600; }
.notice { color: #065f46; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 10px 12px; margin-bottom: 16px; font-size: 14px; }
.divider { display: flex; align-items: center; gap: 12px; margin: 18px 0; color: #6b7280; font-size: 12px; }
.divider::before, .divider::after { content: ''; height: 1px; flex: 1; background: #e5e7eb; }
.social { display: grid; gap: 8px; }
.social button { background: #fff; color: #111827; border: 1px solid #d1d5db; margin-top: 0; }
.alt { margin-top: 18px; font-size: 13px; color: #4b5563; }
ul { padding-left: 18px; }
code { font-size: 13px; word-break: break-all; }
</style>
</head>
<body><main>${safeLogo ? `<img src="${escapeHtml(safeLogo)}" alt="">` : ''}${options.body}</main></body>
</html>`;
	return new Response(html, {
		status: options.status ?? 200,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
			'x-frame-options': 'DENY',
			'referrer-policy': 'same-origin',
			...(options.headers ?? {}),
		},
	});
}

/** Client credentials from HTTP Basic (RFC 6749 §2.3.1) or the form body. */
export function clientCredentials(
	authorization: string | null | undefined,
	form: URLSearchParams,
): { clientId: string; clientSecret: string | null } {
	if (authorization?.startsWith('Basic ')) {
		try {
			const decoded = atob(authorization.slice(6).trim());
			const index = decoded.indexOf(':');
			if (index >= 0) {
				const id = decodeURIComponent(decoded.slice(0, index));
				const secret = decodeURIComponent(decoded.slice(index + 1));
				return { clientId: id, clientSecret: secret || null };
			}
		} catch {
			// Fall through to the body; the engine returns one generic refusal either way.
		}
	}
	return { clientId: form.get('client_id') ?? '', clientSecret: form.get('client_secret') || null };
}

/** A relative issuer path for a pool and an optional page. */
export function poolPath(poolId: string, page?: string): string {
	return `/${encodeURIComponent(poolId)}${page ? `/${page}` : ''}`;
}

/** The headers a browser sees on a redirect. */
export function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
	return new Response(null, { status: 302, headers: { location, ...extraHeaders } });
}

export function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			...headers,
		},
	});
}

// ---------------------------------------------------------------- rate limits

const attempts = new Map<string, number[]>();
const MAX_TRACKED_KEYS = 10_000;

/** A rolling-window limit for hosted forms and passkey endpoints, keyed by address and client. */
export function allowAttempt(key: string, limit = 10, windowMs = 60_000): boolean {
	const now = Date.now();
	const recent = (attempts.get(key) ?? []).filter((at) => now - at < windowMs);
	if (recent.length >= limit) {
		attempts.set(key, recent);
		return false;
	}
	recent.push(now);
	attempts.delete(key);
	attempts.set(key, recent);
	if (attempts.size > MAX_TRACKED_KEYS) {
		for (const [entry, times] of attempts)
			if (times.every((at) => now - at >= windowMs)) attempts.delete(entry);
	}
	return true;
}

/** Tests and long-lived processes can clear the in-memory limiter. */
export function resetAttempts(): void {
	attempts.clear();
}

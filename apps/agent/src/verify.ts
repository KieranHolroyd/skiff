import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DesiredState, RouteSpec } from '@skiff/contracts';

/**
 * Stateless protected-site verification for Caddy's forward_auth (D20).
 *
 * The agent never touches the database or the control plane on the request path:
 * - the visitor cookie is `__skiff_s=<exp>.<hmac(host|exp)>` signed with the route's site key;
 * - the login callback carries a one-time, 60 s token minted by the control plane, also signed
 *   with the site key, which the agent exchanges for the host-only cookie exactly once.
 *
 * Revocation needs no extra state here either: a single share session is refused by id through
 * `state.revocations`, and "sign out everyone" rotates the route's `siteKey` (the control plane
 * bumps the project's session epoch), so every cookie and token signed with the old key fails.
 */

/** Longest callback-token lifetime the agent accepts (60 s plus clock skew). */
export const MAX_CALLBACK_TOKEN_SECONDS = 120;

/**
 * Remembers redeemed callback-token ids until they expire, so a leaked
 * `/_skiff/callback?token=…` URL cannot be replayed (DESIGN §6.4). Memory is bounded by the
 * token lifetime: entries are dropped as soon as the token could no longer verify anyway.
 */
export class UsedTokenCache {
	private readonly used = new Map<string, number>();
	private readonly maxEntries: number;

	constructor(maxEntries = 100_000) {
		this.maxEntries = maxEntries;
	}

	/** Record `jti`; false when it was already redeemed (or the cache is saturated). */
	claim(jti: string, exp: number, now: number): boolean {
		this.prune(now);
		if (this.used.has(jti)) return false;
		// Fail closed under a flood rather than forgetting ids that are still valid.
		if (this.used.size >= this.maxEntries) return false;
		this.used.set(jti, exp);
		return true;
	}

	get size(): number {
		return this.used.size;
	}

	private prune(now: number): void {
		for (const [jti, exp] of this.used) if (exp <= now) this.used.delete(jti);
	}
}

export interface VerifyOptions {
	state: DesiredState | null;
	cookieName: string;
	/** Dev only: omit `Secure` and use http in return URLs. */
	insecureHttp: boolean;
	/** Injectable clock, seconds since epoch. */
	nowSeconds?: () => number;
	/** Redeemed callback tokens; one per agent process. */
	usedTokens?: UsedTokenCache;
}

interface AccessTokenClaims {
	host: string;
	/** Callback-token expiry (≤ 60 s after minting). */
	exp: number;
	/** Session expiry copied into the visitor cookie. */
	sexp: number;
	/** One-time token id. */
	jti: string;
	sub: string;
	kind: string;
	sid?: string;
}

const defaultUsedTokens = new UsedTokenCache();

export function hmacBase64url(secret: string, value: string): string {
	return createHmac('sha256', secret).update(value).digest('base64url');
}

export function signVisitorCookie(
	siteKey: string,
	host: string,
	exp: number,
	sid = '-',
): string {
	return hmacBase64url(siteKey, `${host}|${exp}|${sid}`);
}

export function normalizeHost(value: string | null | undefined): string {
	let host = (value ?? '').trim().toLowerCase();
	if (!host) return '';
	// Strip an optional port, taking care not to mangle an IPv6 literal.
	if (host.startsWith('[')) {
		const end = host.indexOf(']');
		if (end >= 0) host = host.slice(0, end + 1);
	} else {
		const colon = host.lastIndexOf(':');
		if (colon > 0 && host.indexOf(':') === colon) host = host.slice(0, colon);
	}
	host = host.replace(/\.$/, '');
	// Hostnames, IPv4 and bracketed IPv6 only. This keeps `user@host` style values out of
	// redirect URLs, where URL parsing would otherwise change the effective origin.
	if (!/^(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])$/.test(host)) return '';
	return host;
}

export function readCookie(header: string | null, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(';')) {
		const separator = part.indexOf('=');
		if (separator < 0) continue;
		if (part.slice(0, separator).trim() !== name) continue;
		return part.slice(separator + 1).trim();
	}
	return null;
}

/** Verify the host-only session cookie. Returns its expiry when valid and not revoked. */
export function verifyVisitorCookie(
	siteKey: string,
	host: string,
	cookieValue: string | null,
	now: number,
	revokedIds: ReadonlySet<string> = new Set(),
): number | null {
	if (!cookieValue) return null;
	const parts = cookieValue.split('.');
	if (parts.length !== 2 && parts.length !== 3) return null;
	const [expText, sidOrSig, maybeSig] = parts as [string, string, string | undefined];
	const sid = parts.length === 3 ? sidOrSig : '-';
	const signature = parts.length === 3 ? maybeSig! : sidOrSig;
	if (!/^\d+$/.test(expText) || signature.length === 0) return null;
	if (sid !== '-' && revokedIds.has(sid)) return null;
	const exp = Number(expText);
	if (!Number.isSafeInteger(exp) || exp <= now) return null;
	if (!timingSafeEqualText(signVisitorCookie(siteKey, host, exp, sid), signature)) return null;
	return exp;
}

/** Main handler for the agent's unix-socket HTTP server, apart from `/metrics`. */
export function handleSiteRequest(request: Request, options: VerifyOptions): Response {
	const now = options.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
	const url = safeUrl(request.url);
	const pathname = url?.pathname ?? '/';
	const forwardedUri = headerWithoutControls(request.headers.get('x-forwarded-uri'));
	const host = normalizeHost(request.headers.get('x-forwarded-host') ?? request.headers.get('host'));

	if (pathname === '/_skiff/callback' || forwardedUri?.startsWith('/_skiff/callback'))
		return handleCallback(request, options, host, pathname, forwardedUri, now);

	if (pathname !== '/_skiff/verify' && !forwardedUri) return textResponse(404, 'Not found');
	if (!host) return textResponse(404, 'Unknown host');

	const route = findRoute(options.state, host);
	if (!route) return textResponse(404, 'Unknown host');

	// Public routes never reach forward_auth, but answering 200 keeps a misconfiguration safe.
	if (route.accessMode === 'public') return visitorResponse('public', route);

	const exp = verifyVisitorCookie(
		route.access.siteKey,
		host,
		readCookie(request.headers.get('cookie'), options.cookieName),
		now,
		new Set((options.state?.revocations ?? []).map((revocation) => revocation.id)),
	);
	if (exp !== null) return visitorResponse(String(exp), route);

	return redirectToLogin(route, host, forwardedUri, options.insecureHttp);
}

function handleCallback(
	request: Request,
	options: VerifyOptions,
	host: string,
	pathname: string,
	forwardedUri: string | null,
	now: number,
): Response {
	const url = safeUrl(request.url);
	const token =
		pathname === '/_skiff/callback'
			? url?.searchParams.get('token') ?? null
			: queryParam(forwardedUri, 'token');
	if (!token) return textResponse(400, 'Missing token');
	if (!host) return textResponse(404, 'Unknown host');

	const separator = token.indexOf('.');
	if (separator <= 0 || token.indexOf('.', separator + 1) >= 0)
		return textResponse(400, 'Malformed token');
	const payload = token.slice(0, separator);
	const signature = token.slice(separator + 1);

	const claims = decodeClaims(payload);
	if (!claims) return textResponse(400, 'Malformed token');

	const claimedHost = normalizeHost(claims.host);
	const route = findRoute(options.state, claimedHost);
	if (!route) return textResponse(404, 'Unknown host');

	if (!timingSafeEqualText(hmacBase64url(route.access.siteKey, payload), signature))
		return textResponse(403, 'Invalid token');
	if (claimedHost !== host) return textResponse(403, 'Token is for a different host');
	if (claims.exp <= now) return textResponse(403, 'Token has expired');
	// A long-lived token is not a callback token (or predates one-time tokens); refuse it.
	if (claims.exp - now > MAX_CALLBACK_TOKEN_SECONDS) return textResponse(403, 'Invalid token');
	if (claims.sexp <= now) return textResponse(403, 'Session has expired');
	const revoked = new Set((options.state?.revocations ?? []).map((revocation) => revocation.id));
	if (claims.sid && revoked.has(claims.sid)) return textResponse(403, 'Access has been revoked');
	if (!(options.usedTokens ?? defaultUsedTokens).claim(claims.jti, claims.exp, now))
		return textResponse(403, 'Token has already been used');

	const cookieSignature = signVisitorCookie(
		route.access.siteKey,
		claimedHost,
		claims.sexp,
		claims.sid ?? '-',
	);
	const maxAge = Math.max(0, claims.sexp - now);
	const cookieValue = claims.sid
		? `${claims.sexp}.${claims.sid}.${cookieSignature}`
		: `${claims.sexp}.${cookieSignature}`;
	const cookieParts = [`${options.cookieName}=${cookieValue}`, 'Path=/', 'HttpOnly'];
	if (!options.insecureHttp) cookieParts.push('Secure');
	cookieParts.push('SameSite=Lax', `Max-Age=${maxAge}`);
	const cookie = cookieParts.join('; ');

	return new Response(null, {
		status: 302,
		headers: {
			location: '/',
			'cache-control': 'no-store',
			'set-cookie': cookie,
		},
	});
}

const routeCache = new WeakMap<DesiredState, Map<string, RouteSpec>>();

function findRoute(state: DesiredState | null, host: string): RouteSpec | undefined {
	if (!state) return undefined;
	let routes = routeCache.get(state);
	if (!routes) {
		routes = new Map();
		for (const route of state.routes) routes.set(normalizeHost(route.host), route);
		routeCache.set(state, routes);
	}
	return routes.get(host);
}

function redirectToLogin(
	route: RouteSpec,
	host: string,
	forwardedUri: string | null,
	insecureHttp: boolean,
): Response {
	const uri = forwardedUri && forwardedUri.startsWith('/') ? forwardedUri : '/';
	const scheme = insecureHttp ? 'http' : 'https';
	const returnUrl = `${scheme}://${host}${uri}`;

	let login: URL;
	try {
		login = new URL(route.access.loginUrl);
	} catch {
		return textResponse(500, 'Route has an invalid login URL');
	}
	login.searchParams.set('return', returnUrl);

	return new Response(null, {
		status: 302,
		headers: {
			location: login.toString(),
			'cache-control': 'no-store',
		},
	});
}

function visitorResponse(visitor: string, route: RouteSpec): Response {
	return new Response(null, {
		status: 200,
		headers: {
			'x-skiff-visitor': visitor,
			'x-skiff-project': route.projectId,
			'cache-control': 'no-store',
		},
	});
}

function decodeClaims(payload: string): AccessTokenClaims | null {
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;
	const claims = value as Record<string, unknown>;
	if (typeof claims.host !== 'string' || claims.host.length === 0) return null;
	if (typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp)) return null;
	if (typeof claims.sexp !== 'number' || !Number.isSafeInteger(claims.sexp)) return null;
	if (typeof claims.jti !== 'string' || claims.jti.length < 8 || claims.jti.length > 128) return null;
	if (typeof claims.sub !== 'string' || typeof claims.kind !== 'string') return null;
	if (claims.sid !== undefined && typeof claims.sid !== 'string') return null;
	return {
		host: claims.host,
		exp: claims.exp,
		sexp: claims.sexp,
		jti: claims.jti,
		sub: claims.sub,
		kind: claims.kind,
		...(typeof claims.sid === 'string' ? { sid: claims.sid } : {}),
	};
}

function timingSafeEqualText(expected: string, actual: string): boolean {
	const left = Buffer.from(expected, 'utf8');
	const right = Buffer.from(actual, 'utf8');
	return left.length === right.length && timingSafeEqual(left, right);
}

function safeUrl(input: string): URL | null {
	try {
		return new URL(input);
	} catch {
		return null;
	}
}

function queryParam(uri: string | null, name: string): string | null {
	if (!uri) return null;
	const question = uri.indexOf('?');
	if (question < 0) return null;
	const params = new URLSearchParams(uri.slice(question + 1));
	return params.get(name);
}

function headerWithoutControls(value: string | null): string | null {
	if (!value) return null;
	// Caddy supplies the original URI; reject control characters just in case.
	return /[\r\n\0]/.test(value) ? null : value;
}

function textResponse(status: number, body: string): Response {
	return new Response(body, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
	});
}

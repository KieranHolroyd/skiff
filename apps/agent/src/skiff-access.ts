import { createHmac, timingSafeEqual } from 'node:crypto';
import { evaluateAccessEdge, sha256Hex, type RouteSpec } from '@skiff/contracts';

/**
 * Skiff Access, the identity-aware proxy (IAM.md I25, §11.1).
 *
 * Caddy's forward_auth comes here for every request to a host whose mode is `access`. The agent
 * never talks to the control plane on the request path:
 *
 *  - the browser carries a host-only cookie signed with the route's site key, exactly like the
 *    password/platform bridge (`verify.ts`);
 *  - a visitor without one is redirected to `loginUrl` (the platform's `/api/v1/access/authorize`),
 *    which authenticates them, evaluates the policy and returns a single-use, 60 s code bound to
 *    the host at `/_skiff/access/callback`;
 *  - the callback exchanges that code for the cookie and redirects to the original path;
 *  - the upstream app receives `Skiff-Access-Jwt` and `Skiff-Access-Email` copied by Caddy.
 *
 * Latency: verification is HMAC-only, but every request still pays one unix-socket round trip to
 * the agent and one JWT encode. `AccessDecisionCache` remembers the verified decision for a few
 * seconds (default 15 s), which covers asset bursts without letting a revocation linger: "sign out
 * everyone" rotates the site key and the cached entry expires on its own. This is the S6 trade-off
 * documented in IAM.md §11.1.
 */

/** Longest callback-code lifetime the agent accepts (60 s plus clock skew). */
export const MAX_ACCESS_CODE_SECONDS = 120;
/** Default decision cache lifetime; short enough that key rotation is felt quickly. */
export const ACCESS_DECISION_TTL_MS = 15_000;

export interface AccessTokenClaims {
	host: string;
	exp: number;
	sexp: number;
	jti: string;
	sub: string;
	kind: string;
	email?: string;
	sid?: string;
}

export interface AccessCookie {
	exp: number;
	email: string;
}

export interface SkiffAccessOptions {
	/** Visitor cookie name for Skiff Access; separate from the password/platform cookie. */
	accessCookieName: string;
	insecureHttp: boolean;
	/** Injectable clock, seconds since epoch. */
	nowSeconds?: () => number;
	/** One-time callback ids, shared with the password/platform bridge. */
	usedTokens?: { claim(jti: string, exp: number, now: number): boolean };
	/** Revoked share sessions / sign-out epoch ids (state.revocations). */
	revokedIds?: ReadonlySet<string>;
	/** Stable HMAC secret for the upstream JWT; falls back to the route's site key. */
	signingSecret?: string | null;
	cache?: AccessDecisionCache;
	/**
	 * Best-effort last-used reporting for a matched machine token. Called without awaiting; the
	 * default posts the hash to the platform's `/api/v1/access/service-tokens/touch` endpoint. The
	 * hash is already part of desired state, so it is not a credential. Never affects the decision.
	 */
	touchServiceToken?: (input: { policyId: string; header: string; tokenHash: string }) => void;
	/** Throttles last-used reports to at most one a minute; one instance per agent process. */
	touchThrottle?: ServiceTokenTouchThrottle;
}

/** Default touch lifetime; a busy token reports at most once a minute. */
export const SERVICE_TOKEN_TOUCH_TTL_MS = 60_000;

/**
 * Bounds last-used reports so a chatty machine does not turn every request into a platform write.
 * The platform enforces the same interval, but keeping the first gate in the agent means a busy
 * token costs a map lookup rather than an HTTP request.
 */
export class ServiceTokenTouchThrottle {
	private readonly touched = new Map<string, number>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;

	constructor(ttlMs = SERVICE_TOKEN_TOUCH_TTL_MS, maxEntries = 4_096) {
		this.ttlMs = ttlMs;
		this.maxEntries = maxEntries;
	}

	/** True when `key` may be reported at `nowMs`; records the attempt when it returns true. */
	shouldTouch(key: string, nowMs: number): boolean {
		const previous = this.touched.get(key);
		if (previous !== undefined && nowMs - previous < this.ttlMs) return false;
		if (this.touched.size >= this.maxEntries) this.touched.clear();
		this.touched.set(key, nowMs);
		return true;
	}

	get size(): number {
		return this.touched.size;
	}
}

const defaultTouchThrottle = new ServiceTokenTouchThrottle();

export interface CachedDecision {
	expiresAt: number;
	headers: Record<string, string>;
}

/**
 * Verified decisions, keyed by host and cookie. Bounded and time-limited; a full cache fails open
 * to a fresh verification (which is cheap) rather than serving an unbounded map.
 */
export class AccessDecisionCache {
	private readonly entries = new Map<string, CachedDecision>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;

	constructor(ttlMs = ACCESS_DECISION_TTL_MS, maxEntries = 10_000) {
		this.ttlMs = ttlMs;
		this.maxEntries = maxEntries;
	}

	get(key: string, nowMs: number): Record<string, string> | null {
		const entry = this.entries.get(key);
		if (!entry) return null;
		if (entry.expiresAt <= nowMs) {
			this.entries.delete(key);
			return null;
		}
		return entry.headers;
	}

	set(key: string, headers: Record<string, string>, nowMs: number, expiresAtMs?: number): void {
		if (this.entries.size >= this.maxEntries) this.entries.clear();
		this.entries.set(key, {
			expiresAt: Math.min(nowMs + this.ttlMs, expiresAtMs ?? Number.POSITIVE_INFINITY),
			headers,
		});
	}

	get size(): number {
		return this.entries.size;
	}
}

export function hmacBase64url(secret: string, value: string): string {
	return createHmac('sha256', secret).update(value).digest('base64url');
}

export function signAccessCookie(siteKey: string, host: string, exp: number, email: string): string {
	return hmacBase64url(siteKey, `access|${host}|${exp}|${email.toLowerCase()}`);
}

/** Cookie value: `v1.<exp>.<base64url(email)>.<signature>`. */
export function accessCookieValue(
	siteKey: string,
	host: string,
	exp: number,
	email: string,
): string {
	const encoded = Buffer.from(email.toLowerCase(), 'utf8').toString('base64url');
	return `v1.${exp}.${encoded}.${signAccessCookie(siteKey, host, exp, email)}`;
}

export function verifyAccessCookie(
	siteKey: string,
	host: string,
	value: string | null,
	now: number,
): AccessCookie | null {
	if (!value) return null;
	const parts = value.split('.');
	if (parts.length !== 4 || parts[0] !== 'v1') return null;
	const [, expText, encoded, signature] = parts as [string, string, string, string];
	if (!/^\d+$/.test(expText) || signature.length === 0) return null;
	const exp = Number(expText);
	if (!Number.isSafeInteger(exp) || exp <= now) return null;
	let email: string;
	try {
		email = Buffer.from(encoded, 'base64url').toString('utf8').toLowerCase();
	} catch {
		return null;
	}
	if (email.length > 320 || /[\r\n\0]/.test(email)) return null;
	const expected = signAccessCookie(siteKey, host, exp, email);
	if (!timingSafeEqualText(expected, signature)) return null;
	return { exp, email };
}

/**
 * The agent-side handler. `route` is the desired-state route for `host`; it carries the site key
 * and policy id. Returns 200 with the upstream headers, 302 to the platform, or a text error.
 */
export function handleSkiffAccessRequest(
	request: Request,
	options: SkiffAccessOptions,
	route: RouteSpec,
	host: string,
	forwardedUri: string | null,
	now: number,
): Response {
	const path = forwardedPath(forwardedUri) ?? new URL(request.url, 'http://agent.local').pathname;
	if (path === '/_skiff/access/callback') return handleAccessCallback(request, options, route, host, forwardedUri, now);
	if (route.accessMode !== 'access') return textResponse(404, 'Not a Skiff Access host');
	if (!route.access.policyId) return textResponse(500, 'Route has no access policy');
	if (route.access.policyEnabled === false) return textResponse(403, 'Access is closed');

	// Machines present a service token as a header pair; decide that before any redirect, so a CI
	// job or webhook never lands on a browser login page (IAM.md I25, §11.1).
	const machine = evaluateAccessEdge(
		route.access.serviceTokens ?? [],
		requestHeaders(request.headers),
		route.access.hasPersonRules ?? true,
	);
	if (machine.decision === 'deny') return textResponse(403, 'Access denied');
	if (machine.decision === 'allow') {
		// Reporting last use is fire-and-forget: a slow or unreachable platform must never delay the
		// machine's request, and the decision above is already final.
		reportServiceTokenUse(route, request.headers, machine.header, options, now);
		const headers = accessHeaders(route, host, '', now, options, machine.header);
		return new Response(null, { status: 200, headers });
	}

	const cookie = readCookie(request.headers.get('cookie'), options.accessCookieName);
	const cache = options.cache;
	// The site key already folds in the policy's revocation version: a bump on this policy must
	// not serve an old allow, while another policy on the same host keeps its key and cached entry.
	const cacheKey = `${host}|${route.access.policyId ?? ''}|${route.access.siteKey}|${cookie ?? ''}`;
	const nowMs = now * 1000;
	const cached = cache?.get(cacheKey, nowMs);
	if (cached) return new Response(null, { status: 200, headers: cached });

	const visitor = verifyAccessCookie(route.access.siteKey, host, cookie, now);
	if (!visitor) return redirectToAuthorize(route, host, forwardedUri, options.insecureHttp);

	const headers = accessHeaders(route, host, visitor.email, now, options);
	cache?.set(cacheKey, headers, nowMs, visitor.exp * 1000);
	return new Response(null, { status: 200, headers });
}

/**
 * Report that a machine token was used. The matched hash is recomputed locally from the header
 * value (the rule list only carries hashes), then throttled and posted without awaiting. A token
 * that matched a legacy rule in the policy JSON is reported too; the platform's endpoint ignores
 * hashes that are not named DB tokens.
 */
function reportServiceTokenUse(
	route: RouteSpec,
	headers: Headers,
	header: string,
	options: SkiffAccessOptions,
	now: number,
): void {
	const policyId = route.access.policyId;
	if (!policyId) return;
	const value = headers.get(header);
	if (!value) return;
	const tokenHash = sha256Hex(value);
	const matched = (route.access.serviceTokens ?? []).some(
		(token) => token.header.toLowerCase() === header.toLowerCase() && token.tokenHash === tokenHash,
	);
	if (!matched) return;
	const throttle = options.touchThrottle ?? defaultTouchThrottle;
	if (!throttle.shouldTouch(`${policyId}|${tokenHash}`, now * 1000)) return;
	const input = { policyId, header, tokenHash };
	try {
		if (options.touchServiceToken) options.touchServiceToken(input);
		else postServiceTokenTouch(route.access.loginUrl, input);
	} catch {
		// Last-used telemetry is best effort and must never turn an allow into an error.
	}
}

/** Fire-and-forget POST to the platform; the authorize origin is the platform's own origin. */
function postServiceTokenTouch(
	loginUrl: string,
	input: { policyId: string; header: string; tokenHash: string },
): void {
	let url: URL;
	try {
		url = new URL('/api/v1/access/service-tokens/touch', loginUrl);
	} catch {
		return;
	}
	void fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
		cache: 'no-store',
	}).catch(() => undefined);
}

function handleAccessCallback(
	request: Request,
	options: SkiffAccessOptions,
	route: RouteSpec,
	host: string,
	forwardedUri: string | null,
	now: number,
): Response {
	const url = safeUrl(request.url);
	const token =
		queryParam(forwardedUri, 'token') ?? url?.searchParams.get('token') ?? null;
	const next = safeNext(queryParam(forwardedUri, 'next') ?? url?.searchParams.get('next') ?? null);
	if (!token) return textResponse(400, 'Missing code');

	const separator = token.indexOf('.');
	if (separator <= 0 || token.indexOf('.', separator + 1) >= 0) return textResponse(400, 'Malformed code');
	const payload = token.slice(0, separator);
	const signature = token.slice(separator + 1);
	const claims = decodeClaims(payload);
	if (!claims) return textResponse(400, 'Malformed code');
	if (claims.kind !== 'access') return textResponse(403, 'Not a Skiff Access code');
	if (normalizeHost(claims.host) !== host) return textResponse(403, 'Code is for a different host');
	if (!timingSafeEqualText(hmacBase64url(route.access.siteKey, payload), signature))
		return textResponse(403, 'Invalid code');
	if (claims.exp <= now) return textResponse(403, 'Code has expired');
	if (claims.exp - now > MAX_ACCESS_CODE_SECONDS) return textResponse(403, 'Invalid code');
	if (claims.sexp <= now) return textResponse(403, 'Session has expired');
	if (claims.sid && options.revokedIds?.has(claims.sid)) return textResponse(403, 'Access has been revoked');
	if (!(options.usedTokens?.claim(claims.jti, claims.exp, now) ?? false))
		return textResponse(403, 'Code has already been used');

	const email = claims.email?.trim().toLowerCase() ?? '';
	const cookie = accessCookieValue(route.access.siteKey, host, claims.sexp, email);
	const maxAge = Math.max(0, claims.sexp - now);
	const parts = [
		`${options.accessCookieName}=${cookie}`,
		'Path=/',
		'HttpOnly',
		...(options.insecureHttp ? [] : ['Secure']),
		'SameSite=Lax',
		`Max-Age=${maxAge}`,
	];
	return new Response(null, {
		status: 302,
		headers: {
			location: next ?? '/',
			'cache-control': 'no-store',
			'set-cookie': parts.join('; '),
		},
	});
}

/** The headers Caddy copies to the upstream app. */
function accessHeaders(
	route: RouteSpec,
	host: string,
	email: string,
	now: number,
	options: SkiffAccessOptions,
	/** Set for a service-token request: the machine's identity, with no email. */
	serviceHeader?: string,
): Record<string, string> {
	const headers: Record<string, string> = {
		'Skiff-Access-Jwt': signAccessJwt(options.signingSecret ?? route.access.siteKey, {
			host,
			email,
			policyId: route.access.policyId ?? '',
			subject: serviceHeader ? `service:${host}` : `access:${email || host}`,
			now,
			...(serviceHeader ? { identity: 'service' as const } : {}),
		}),
		// Copied upstream even when empty so the header pair is predictable for apps.
		'Skiff-Access-Email': email,
		'cache-control': 'no-store',
	};
	if (serviceHeader) {
		headers['Skiff-Access-Identity'] = 'service';
		headers['Skiff-Access-Service'] = serviceHeader;
	}
	return headers;
}

/** Header + claims of the upstream JWT, signed HS256 with the agent's access secret. */
export function signAccessJwt(
	secret: string,
	input: {
		host: string;
		email: string;
		policyId: string;
		subject: string;
		now: number;
		ttlSeconds?: number;
		/** `service` marks a machine allowed by a service token; it never carries an email. */
		identity?: 'user' | 'service';
	},
): string {
	const header = { alg: 'HS256', typ: 'JWT', kid: 'access' };
	const issuedAt = input.now;
	const payload = {
		iss: 'skiff-access',
		aud: input.host,
		sub: input.subject,
		email: input.email || undefined,
		host: input.host,
		policy: input.policyId || undefined,
		purpose: 'access',
		...(input.identity === 'service' ? { identity: 'service' } : {}),
		iat: issuedAt,
		exp: issuedAt + (input.ttlSeconds ?? 15 * 60),
	};
	const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
	const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const signature = hmacBase64url(secret, `${encodedHeader}.${encodedPayload}`);
	return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function redirectToAuthorize(
	route: RouteSpec,
	host: string,
	forwardedUri: string | null,
	insecureHttp: boolean,
): Response {
	let login: URL;
	try {
		login = new URL(route.access.loginUrl);
	} catch {
		return textResponse(500, 'Route has an invalid login URL');
	}
	const uri = forwardedUri && forwardedUri.startsWith('/') ? forwardedUri : '/';
	const scheme = insecureHttp ? 'http' : 'https';
	const returnUrl = `${scheme}://${host}${uri}`;
	login.searchParams.set('host', host);
	login.searchParams.set('return', returnUrl);
	return new Response(null, {
		status: 302,
		headers: { location: login.toString(), 'cache-control': 'no-store' },
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
	if (claims.email !== undefined && typeof claims.email !== 'string') return null;
	return {
		host: claims.host,
		exp: claims.exp,
		sexp: claims.sexp,
		jti: claims.jti,
		sub: claims.sub,
		kind: claims.kind,
		...(typeof claims.email === 'string' ? { email: claims.email } : {}),
		...(typeof claims.sid === 'string' ? { sid: claims.sid } : {}),
	};
}

function readCookie(header: string | null, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(';')) {
		const separator = part.indexOf('=');
		if (separator < 0) continue;
		if (part.slice(0, separator).trim() !== name) continue;
		return part.slice(separator + 1).trim();
	}
	return null;
}

/** Lowercase header names, as the policy evaluator looks them up. */
function requestHeaders(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, name) => {
		record[name.toLowerCase()] = value;
	});
	return record;
}

function forwardedPath(uri: string | null): string | null {
	if (!uri) return null;
	const question = uri.indexOf('?');
	return question < 0 ? uri : uri.slice(0, question);
}

function safeNext(value: string | null): string | null {
	if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
	if (/[\r\n\0]/.test(value)) return null;
	return value;
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
	return new URLSearchParams(uri.slice(question + 1)).get(name);
}

function normalizeHost(value: string | null | undefined): string {
	let host = (value ?? '').trim().toLowerCase();
	if (!host) return '';
	if (host.startsWith('[')) {
		const end = host.indexOf(']');
		if (end >= 0) host = host.slice(0, end + 1);
	} else {
		const colon = host.lastIndexOf(':');
		if (colon > 0 && host.indexOf(':') === colon) host = host.slice(0, colon);
	}
	return host.replace(/\.$/, '');
}

function timingSafeEqualText(expected: string, actual: string): boolean {
	const left = Buffer.from(expected, 'utf8');
	const right = Buffer.from(actual, 'utf8');
	return left.length === right.length && timingSafeEqual(left, right);
}

function textResponse(status: number, body: string): Response {
	return new Response(body, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
	});
}

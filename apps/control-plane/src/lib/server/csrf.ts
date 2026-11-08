/**
 * Skiff's CSRF / Origin policy (DESIGN §5, D19: strict Origin checks on every mutation).
 *
 * SvelteKit's built-in check is disabled (vite.config.ts `csrf.trustedOrigins: ['*']`) because it
 * runs before hooks, applies globally, and would block OAuth endpoints that are cross-origin by
 * design. This replaces it with a stricter rule: every non-safe request must prove it's
 * same-origin, except endpoints that never authenticate with cookies.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Endpoints authenticated by PKCE / client credentials / bearer tokens, never by the session
 * cookie, so a cross-site request gains nothing. Exact paths only — no prefixes.
 */
const COOKIELESS_ENDPOINTS = new Set([
	'/api/auth/oauth2/token',
	'/api/auth/oauth2/register',
	'/api/auth/oauth2/revoke',
	'/api/auth/oauth2/introspect',
	'/api/v1/cli/token',
	'/api/domains/ask',
	'/mcp',
	'/_skiff/site-login',
]);

/**
 * Prefixes of endpoints authenticated exclusively by a bearer/signature (node tokens, presigned
 * object URLs). A cross-site request gains nothing there. Prefixes end in `/` so they never match
 * a sibling path in the cookie-authenticated REST API.
 */
// `/share/storage/` is authenticated by an unguessable share token, never a cookie.
const COOKIELESS_PREFIXES = [
	'/api/agent/',
	// Pipeline job tokens (docs/PIPELINES.md W9): bearer only, never a cookie.
	'/api/pipeline/',
	'/api/objects/',
	'/api/backup-targets/',
	'/api/webhooks/',
	'/share/storage/',
];

export type CsrfDecision = { ok: true } | { ok: false; reason: string };

export function checkCsrf(request: Request, url: URL, platformOrigin: string): CsrfDecision {
	if (SAFE_METHODS.has(request.method)) return { ok: true };
	if (COOKIELESS_ENDPOINTS.has(url.pathname)) return { ok: true };
	if (COOKIELESS_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return { ok: true };

	const origin = request.headers.get('origin');
	if (origin) {
		return origin === platformOrigin
			? { ok: true }
			: { ok: false, reason: `cross-origin ${request.method} from ${origin}` };
	}
	// Some clients omit Origin on same-origin requests; fall back to Fetch Metadata.
	const site = request.headers.get('sec-fetch-site');
	if (site === 'same-origin') return { ok: true };
	return { ok: false, reason: `${request.method} without Origin or same-origin Sec-Fetch-Site` };
}

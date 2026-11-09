import { join } from 'node:path';
import type { RouteSpec } from '@yoal/contracts';
import {
	compilePattern,
	compileTarget,
	errorPageHandler,
	type CaddyHandler,
	type CaddyRoute,
	type HeaderRule,
	type Redirect,
	type SiteCompileInput,
} from '@yoal/site-config';

/**
 * Caddy route for a `runtime: "function"` site (docs/FUNCTIONS.md §4.2, D110).
 *
 * A function project serves static assets first and falls through to the workerd host for
 * anything else, so the route is a `subroute` in this order:
 *
 *   auth (protected only) → security headers → run_worker_first → file_server → function proxy
 *
 * `site-config` only knows about static files and worker upstreams, and `compileSiteRoute` is the
 * single owner of those routes. Rather than fork it, the agent swaps the compiled site route for
 * this one when the route carries `function` (see `caddy-config.ts`). The auth and header shapes
 * are copied from `packages/site-config/src/compile.ts` on purpose: those helpers are private to
 * that package and the two routes must stay structured identically.
 */

/** The routing half of `RouteSpec.function`: `assetsDirectory` plus `run_worker_first` globs. */
export type FunctionRouteSpec = NonNullable<RouteSpec['function']>;

const SECURITY_HEADERS: Record<string, string[]> = {
	'Strict-Transport-Security': ['max-age=63072000; includeSubDomains'],
	'X-Content-Type-Options': ['nosniff'],
	'Referrer-Policy': ['strict-origin-when-cross-origin'],
};

/** Characters that are special to Go's regexp syntax and therefore force a `path_regexp` matcher. */
const REGEX_SPECIAL = /[.[\]{}()^$|\\+]/;

/**
 * Files tried before the function. `{http.request.uri.path}` (not `{http.request.uri}`) is
 * deliberate: the latter includes the query string, so `/app.js?v=1` would never match a file and
 * `?` is even a glob wildcard to Caddy's `file` matcher. The index fallback serves clean URLs.
 */
const ASSET_TRY_FILES = ['{http.request.uri.path}', '{http.request.uri.path}/index.html'];

/**
 * Resolve `<releaseRoot>/<assetsDirectory>` for a function site. Route specs are validated by the
 * control plane, but the agent still refuses a directory that could escape the release: one bad
 * desired state must not make Caddy serve arbitrary files.
 */
export function functionAssetsRoot(releasePath: string, assetsDirectory: string): string {
	const segments = assetsDirectory.split('/');
	if (
		assetsDirectory.length === 0 ||
		!segments.every((segment) => /^[A-Za-z0-9._@+-]+$/.test(segment)) ||
		segments.some((segment) => segment === '..')
	) {
		throw new Error(`Invalid function assets directory: ${assetsDirectory}`);
	}
	return join(releasePath, assetsDirectory);
}

/**
 * Translate glob syntax to an anchored Go regular expression. `*` and `**` both match any run of
 * characters (Caddy's `path` matcher wildcard spans slashes), `?` matches one character, and every
 * other character is escaped so a bundle cannot inject regex syntax into the config.
 */
export function globToRegExp(glob: string): string {
	let out = '';
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index]!;
		if (char === '*') {
			out += '.*';
			// Consume the second star of `**`; it means the same thing as `*` here.
			if (glob[index + 1] === '*') index += 1;
		} else if (char === '?') {
			out += '.';
		} else {
			out += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
		}
	}
	return `^${out}$`;
}

/** Group normalised globs into Caddy matcher sets: cheap `path` first, `path_regexp` for the rest. */
function matchSets(patterns: readonly string[]): Record<string, unknown>[] {
	const simple = new Set<string>();
	const regex: string[] = [];
	for (const pattern of patterns) {
		if (pattern.includes('**') || REGEX_SPECIAL.test(pattern)) {
			if (!regex.includes(pattern)) regex.push(pattern);
		} else {
			simple.add(pattern);
		}
	}
	const sets: Record<string, unknown>[] = [];
	if (simple.size > 0) sets.push({ path: [...simple] });
	for (const pattern of regex) sets.push({ path_regexp: { pattern: globToRegExp(pattern) } });
	return sets;
}

/**
 * Caddy matchers for `run_worker_first` (wrangler's `assets.run_worker_first`).
 *
 * Positive globs make those paths reach the function *before* the file server. A `!`-prefixed glob
 * excludes a path, and a list of exclusions alone means "worker first everywhere except these".
 * Returns an empty array only for an empty glob list; otherwise at least one matcher set, so the
 * caller can tell "no worker-first route" from "my matcher failed closed".
 */
export function runWorkerFirstMatch(globs: readonly string[]): unknown[] {
	const positives: string[] = [];
	const negatives: string[] = [];
	for (const glob of globs) {
		const negative = glob.startsWith('!');
		const pattern = negative ? glob.slice(1) : glob;
		if (pattern.length === 0) throw new Error(`Empty function asset glob: ${JSON.stringify(glob)}`);
		// Caddy's `path` matcher only accepts patterns that begin with `/`; the contract allows both.
		const normalised = pattern.startsWith('/') ? pattern : `/${pattern}`;
		(negative ? negatives : positives).push(normalised);
	}
	if (positives.length === 0 && negatives.length === 0) return [];

	const exclusions = matchSets(negatives);
	// With no positive glob the route applies everywhere; the exclusions carve out the static paths.
	const sets = positives.length > 0 ? matchSets(positives) : [{}];
	return sets.map((set) => (exclusions.length > 0 ? { ...set, not: exclusions } : set));
}

/** `forward_auth` against the local agent, identical to `compileSiteRoute`'s auth block. */
function authRoute(agentSocket: string): CaddyRoute {
	return {
		handle: [
			{
				handler: 'reverse_proxy',
				upstreams: [{ dial: `unix/${agentSocket}` }],
				rewrite: { method: 'GET', uri: '/_yoal/verify' },
				headers: {
					request: {
						set: {
							'X-Forwarded-Uri': ['{http.request.uri}'],
							'X-Yoal-Project': ['{http.request.host}'],
						},
					},
				},
				handle_response: [
					{ match: { status_code: [2] }, routes: [{ handle: [{ handler: 'vars' }] }] },
				],
			},
		],
	};
}

/**
 * Security headers for every response, including the function's. Protected sites additionally keep
 * `noindex` and `private` so a shared cache never stores content behind forward_auth (DESIGN §6.4).
 */
function headersRoute(protectedSite: boolean): CaddyRoute {
	return {
		handle: [
			{
				handler: 'headers',
				response: {
					set: {
						...SECURITY_HEADERS,
						...(protectedSite
							? { 'X-Robots-Tag': ['noindex'], 'Cache-Control': ['private'] }
							: {}),
					},
				},
			},
		],
	};
}

/** Protected sites must never let an `_headers` Cache-Control rule make content public. */
function privateCacheControl(value: string): string {
	const directives = value
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part && !/^(?:public|private)$/i.test(part) && !/^s-maxage=/i.test(part));
	return ['private', ...directives].join(', ');
}

/** A `_headers` rule, matched by path (Caddy's `path` matcher understands `*`). */
function headersRule(rule: HeaderRule, protectedSite: boolean): CaddyRoute {
	const set: Record<string, string[]> = {};
	for (const [name, value] of Object.entries(rule.headers))
		set[name] = [
			protectedSite && name.toLowerCase() === 'cache-control' ? privateCacheControl(value) : value,
		];
	return { match: [{ path: [rule.path] }], handle: [{ handler: 'headers', response: { set } }] };
}

/**
 * A `_redirects` rule, compiled with the static tier's own pattern/target compiler so a function
 * project's rules behave identically to a static site's (D30). A 200 status rewrites and falls
 * through to the worker; a 3xx/4xx terminates with a static response.
 */
function redirectRule(redirect: Redirect): CaddyRoute {
	const compiled = compilePattern(redirect.from);
	const target = compileTarget(redirect.to);
	const hasPattern = compiled.groups.length > 0;
	const match = hasPattern
		? [{ path_regexp: { name: 'yoal_redirect', pattern: compiled.regex } }]
		: [{ path: [redirect.from] }];
	if (redirect.status === 200) return { match, handle: [{ handler: 'rewrite', uri: target }] };
	if (redirect.status >= 300 && redirect.status < 400)
		return {
			match,
			handle: [
				{ handler: 'static_response', status_code: redirect.status, headers: { Location: [target] } },
			],
		};
	return { match, handle: [{ handler: 'static_response', status_code: redirect.status, body: '' }] };
}

/** How long Caddy keeps retrying a function socket that refuses connections. */
export const FUNCTION_DIAL_RETRY = '30s';

/**
 * The function host. `X-Yoal-Internal: 0` overwrites a client-supplied value so the shim's
 * `POST /__yoal/scheduled` and `/__yoal/queue` routes stay unreachable from the internet (FN9:
 * only the node's timer sends `1`). The 5-minute response header timeout is FN5's wall clock for
 * `fetch` (docs/FUNCTIONS.md §4.7, sized for long AI calls); Caddy sets none by default, so a hung
 * host would otherwise hold the request open indefinitely.
 *
 * Phase 4: `upstreams` holds one dial target per replica, in order, so Caddy balances a stateless
 * function over its hosts. One target renders exactly as the single-host route always has.
 */
function proxyHandler(upstreams: readonly string[]): CaddyHandler {
	return {
		handler: 'reverse_proxy',
		upstreams: upstreams.map((upstream) => ({ dial: upstream.replace(/^https?:\/\//, '') })),
		// Hold the request while the host's socket is briefly absent (a deploy or the watchdog
		// restarting the `.socket` unit) instead of answering 503 at once. A listening socket
		// already queues the connection through a cold start; this covers the gaps between
		// listeners. Caddy only retries failed dials, so a request the host saw is never resent.
		load_balancing: { try_duration: FUNCTION_DIAL_RETRY, try_interval: '250ms' },
		headers: {
			request: {
				set: {
					'X-Yoal-Internal': ['0'],
					'X-Forwarded-Host': ['{http.request.host}'],
				},
			},
		},
		transport: { protocol: 'http', response_header_timeout: '5m' },
		handle_response: [
			{
				match: { status_code: [502, 503, 504] },
				routes: [{ handle: [errorPageHandler('unavailable', 503, { 'Retry-After': ['30'] })] }],
			},
		],
	};
}

/**
 * Replace a compiled site route with the function route. The `@id`, host match and `terminal` flag
 * are preserved so route ordering, TLS management and the custom-domain clone keep working.
 */
export function compileFunctionRoute(site: SiteCompileInput, fn: FunctionRouteSpec): CaddyRoute {
	// The control plane lists every replica socket for a scaled stateless function (phase 4). Older
	// desired state and single-host functions carry only `upstream`, which stays the primary target.
	const upstreams = fn.upstreams?.length ? fn.upstreams : site.upstream ? [site.upstream] : [];
	if (upstreams.length === 0) throw new Error(`Function route ${site.host} has no upstream to proxy to`);
	const protectedSite = site.accessMode !== 'public';
	const routes: CaddyRoute[] = [];

	if (protectedSite && site.agentSocket) routes.push(authRoute(site.agentSocket));
	routes.push(headersRoute(protectedSite));
	// Keep the static tier's `_redirects` and `_headers` behaviour for the asset half (D30).
	for (const redirect of site.redirects) routes.push(redirectRule(redirect));
	for (const rule of site.headers) routes.push(headersRule(rule, protectedSite));

	// Without an assets directory every request is the function's; a worker-first route would only
	// duplicate the fallback.
	if (fn.assetsDirectory !== null) {
		const assetsRoot = functionAssetsRoot(site.releasePath, fn.assetsDirectory);
		if (fn.runWorkerFirst.length > 0) {
			routes.push({ match: runWorkerFirstMatch(fn.runWorkerFirst), handle: [proxyHandler(upstreams)] });
		}
		routes.push({
			match: [
				{
					file: {
						// The matcher resolves existence itself, so it needs the same root as file_server.
						root: assetsRoot,
						try_files: [...ASSET_TRY_FILES],
						try_policy: 'first_exist',
					},
				},
			],
			handle: [
				{
					handler: 'file_server',
					root: assetsRoot,
					precompressed: { br: {}, gzip: {} },
					precompressed_order: ['br', 'gzip'],
				},
			],
		});
	}

	// Anything that did not hit a file is the function's: API routes, dynamic pages, 404s.
	routes.push({ handle: [proxyHandler(upstreams)] });

	return {
		'@id': `site:${site.projectId}:${site.deploymentId ?? site.host}:${site.host}`,
		match: [{ host: [site.host] }],
		terminal: true,
		handle: [{ handler: 'subroute', routes }],
	};
}

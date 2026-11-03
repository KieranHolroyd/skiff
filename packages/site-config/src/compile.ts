import { compilePattern, compileTarget, type HeaderRule, type Redirect, type SiteConfig } from './parse.ts';
import type { AccessMode } from '@skiff/contracts';

/** Structural Caddy JSON — intentionally loose; the agent validates with Caddy itself. */
export type CaddyHandler = Record<string, unknown>;
export interface CaddyRoute {
	'@id'?: string;
	match?: unknown[];
	handle?: CaddyHandler[];
	terminal?: boolean;
}

export interface SiteCompileInput {
	host: string;
	projectId: string;
	/** Deployment id makes route ids unique when production and previews share a project. */
	deploymentId?: string;
	/** Absolute path of the active release symlink. */
	releasePath: string;
	/** Unix socket of the node agent's forward_auth endpoint, when access is protected. */
	agentSocket?: string | null;
	accessMode: AccessMode;
	site: SiteConfig;
	redirects: Redirect[];
	headers: HeaderRule[];
	/** Login URL on the platform domain. */
	loginUrl: string;
	/** Additional paths that must be cached immutably (hashed build output). */
	immutablePaths?: string[];
	/** Worker upstream (edge only); when present the edge proxies instead of serving files. */
	upstream?: string | null;
}

const SECURITY_HEADERS = {
	'Strict-Transport-Security': ['max-age=63072000; includeSubDomains'],
	'X-Content-Type-Options': ['nosniff'],
	'Referrer-Policy': ['strict-origin-when-cross-origin'],
};

function headerHandler(set: Record<string, string[]>, extra?: Record<string, string[]>): CaddyHandler {
	return { handler: 'headers', response: { set: { ...set, ...extra } } };
}

/** forward_auth against the local agent; the agent verifies the host-only HMAC cookie statelessly. */
function authRoute(agentSocket: string): CaddyRoute {
	return {
		handle: [
			{
				handler: 'reverse_proxy',
				upstreams: [{ dial: `unix/${agentSocket}` }],
				rewrite: { method: 'GET', uri: '/_skiff/verify' },
				headers: {
					request: {
						set: {
							'X-Forwarded-Uri': ['{http.request.uri}'],
							'X-Skiff-Project': ['{http.request.host}'],
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

function redirectRoute(redirect: Redirect): CaddyRoute {
	const compiled = compilePattern(redirect.from);
	const target = compileTarget(redirect.to);
	const hasPattern = compiled.groups.length > 0;
	const match = hasPattern
		? [{ path_regexp: { name: 'skiff_redirect', pattern: compiled.regex } }]
		: [{ path: [redirect.from] }];
	if (redirect.status === 200) {
		return { match, handle: [{ handler: 'rewrite', uri: target }] };
	}
	if (redirect.status >= 300 && redirect.status < 400) {
		return {
			match,
			handle: [
				{
					handler: 'static_response',
					status_code: redirect.status,
					headers: { Location: [target] },
				},
			],
		};
	}
	// 404/410/451: terminate with the requested status instead of redirecting.
	return { match, handle: [{ handler: 'static_response', status_code: redirect.status, body: '' }] };
}

function headersRoute(rule: HeaderRule): CaddyRoute {
	const set: Record<string, string[]> = {};
	for (const [name, value] of Object.entries(rule.headers)) set[name] = [value];
	const match = rule.path.includes('*')
		? [{ path: [rule.path] }]
		: [{ path: [rule.path] }];
	return { match, handle: [headerHandler(set)] };
}

function trailingSlashRoutes(site: SiteConfig): CaddyRoute[] {
	if (site.trailingSlash === 'ignore') return [];
	if (site.trailingSlash === 'always') {
		return [
			{
				match: [
					{
						path_regexp: { name: 'skiff_no_slash', pattern: '^(?P<path>.*[^/])$' },
						not: [{ path_regexp: { pattern: '\\.[a-zA-Z0-9]{1,8}$' } }],
					},
				],
				handle: [{ handler: 'redir', to: '{http.request.uri}/', status_code: 308 }],
			},
		];
	}
	return [
		{
			match: [{ path_regexp: { name: 'skiff_slash', pattern: '^(?P<path>.+)/$' } }],
			handle: [{ handler: 'redir', to: '{http.regexp.path}', status_code: 308 }],
		},
	];
}

function cacheRoutes(immutablePaths: string[]): CaddyRoute[] {
	const immutable = [
		'/_app/immutable/*',
		'/assets/*',
		'/_astro/*',
		...immutablePaths,
		/\/[^/]+\.[a-f0-9]{8,}\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico|map)$/,
	];
	return [
		{
			match: [{ path: immutable.filter((p): p is string => typeof p === 'string') }],
			handle: [headerHandler({ 'Cache-Control': ['public, max-age=31536000, immutable'] })],
		},
		{
			match: [{ path_regexp: { pattern: '\\.[a-f0-9]{8,}\\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico|map)$' } }],
			handle: [headerHandler({ 'Cache-Control': ['public, max-age=31536000, immutable'] })],
		},
		{
			match: [{ path: ['/', '*.html'] }],
			handle: [headerHandler({ 'Cache-Control': ['no-cache'] })],
		},
	];
}

/** A single host's route: auth → security/custom headers → redirects → rewrites → files → 404. */
export function compileSiteRoute(input: SiteCompileInput): CaddyRoute {
	const protectedSite = input.accessMode !== 'public';
	const routes: CaddyRoute[] = [];

	if (protectedSite && input.agentSocket) routes.push(authRoute(input.agentSocket));

	routes.push({
		handle: [
			headerHandler(
				SECURITY_HEADERS,
				protectedSite
					? { 'X-Robots-Tag': ['noindex'], 'Cache-Control': ['private'] }
					: undefined,
			),
		],
	});

	for (const redirect of input.redirects) routes.push(redirectRoute(redirect));
	routes.push(...trailingSlashRoutes(input.site));

	if (input.site.cleanUrls) {
		routes.push({
			match: [
				{
					file: {
						try_files: ['{http.request.uri}.html', '{http.request.uri}/index.html'],
						try_policy: 'first_exist',
					},
				},
			],
			handle: [{ handler: 'rewrite', uri: '{http.matchers.file.relative}' }],
		});
	}

	if (input.site.spa) {
		routes.push({
			match: [
				{
					not: [
						{ path_regexp: { pattern: '\\.[a-zA-Z0-9]{1,8}$' } },
						{ path: ['/_app/*', '/assets/*'] },
					],
				},
			],
			handle: [{ handler: 'rewrite', uri: '/index.html' }],
		});
	}

	routes.push(...cacheRoutes(input.immutablePaths ?? []));
	// Site `_headers` come after the defaults so they can override cache policy for a path.
	for (const rule of input.headers) routes.push(headersRoute(rule));

	if (input.upstream) {
		// Homelab/worker placement: the edge terminates TLS and proxies over WireGuard. If the
		// worker is unreachable, serve a branded 503 with Retry-After instead of a bare error.
		routes.push({
			handle: [
				{
					handler: 'reverse_proxy',
					upstreams: [{ dial: input.upstream.replace(/^https?:\/\//, '') }],
					headers: { request: { set: { 'X-Forwarded-Host': ['{http.request.host}'] } } },
					handle_response: [
						{
							match: { status_code: [502, 503, 504] },
							routes: [
								{
									handle: [
										{
											handler: 'static_response',
											status_code: 503,
											headers: { 'Retry-After': ['30'] },
											body: 'This site is temporarily unavailable. Please try again shortly.',
										},
									],
								},
							],
						},
					],
				},
			],
		});
	} else {
		routes.push({
			handle: [
				{
					handler: 'file_server',
					root: input.releasePath,
					precompressed: { br: {}, gzip: {} },
					precompressed_order: ['br', 'gzip'],
				},
			],
		});
	}

	return {
		'@id': `site:${input.projectId}:${input.deploymentId ?? input.host}:${input.host}`,
		match: [{ host: [input.host] }],
		terminal: true,
		handle: [{ handler: 'subroute', routes }],
	};
}

/**
 * Per-site branded 404. Caddy keeps one error-route set per server, so these are merged into
 * `errors.routes` and matched by host.
 */
export function compileErrorRoute(host: string, releasePath: string, notFound: string | null): CaddyRoute | null {
	if (!notFound) return null;
	const safe = notFound.replace(/^\/+/, '');
	return {
		'@id': `error:${host}`,
		match: [{ host: [host] }],
		handle: [
			{ handler: 'rewrite', uri: `/${safe}` },
			{
				handler: 'file_server',
				root: releasePath,
				precompressed: { br: {}, gzip: {} },
				precompressed_order: ['br', 'gzip'],
			},
		],
	};
}

export interface TlsOptions {
	/** ACME account email. */
	email: string;
	/** Cloudflare API token for DNS-01; without it, Caddy falls back to HTTP-01 (single host only). */
	cloudflareApiToken?: string;
	/** ACME directory URL (staging). */
	ca?: string;
	/** Names the policy covers, e.g. `*.example.com` and `example.com`. */
	subjects: string[];
	/** Redirect :80 to https. Default true. */
	httpRedirect?: boolean;
}

/** Wildcard certs via ACME DNS-01 (DESIGN §5, D8, D34). */
function tlsApp(tls: TlsOptions): Record<string, unknown> {
	const issuer: Record<string, unknown> = {
		module: 'acme',
		email: tls.email,
		...(tls.ca ? { ca: tls.ca } : {}),
	};
	if (tls.cloudflareApiToken) {
		issuer.challenges = {
			dns: { provider: { name: 'cloudflare', api_token: tls.cloudflareApiToken } },
		};
	}
	return {
		automation: {
			policies: [{ subjects: tls.subjects, issuers: [issuer] }],
		},
	};
}

/** Full Caddy HTTP app config. The agent applies all routes in a single PUT per reconcile. */
export function compileCaddyConfig(options: {
	listen: string[];
	sites: SiteCompileInput[];
	catchAllStatus?: number;
	tls?: TlsOptions;
	/** Serve plain HTTP on :80 only to redirect to HTTPS. */
	httpRedirect?: boolean;
	/** Platform dashboard/API/MCP route, preserved when the agent replaces the whole config. */
	platform?: { host: string; upstream: string };
	/** Always keep the content apex + wildcard in config so Caddy maintains the wildcard cert. */
	contentDomain?: string;
}): Record<string, unknown> {
	const routes = options.sites.map(compileSiteRoute);
	if (options.platform) {
		const upstream = options.platform.upstream.replace(/^https?:\/\//, '');
		routes.unshift({
			'@id': 'platform',
			match: [{ host: [options.platform.host] }],
			terminal: true,
			handle: [
				{ handler: 'encode', encodings: { zstd: {}, gzip: {} } },
				{
					handler: 'reverse_proxy',
					upstreams: [{ dial: upstream }],
					headers: {
						request: {
							set: {
								'X-Forwarded-Host': ['{http.request.host}'],
								'X-Forwarded-Proto': ['{http.request.scheme}'],
							},
						},
					},
				},
			],
		});
	}
	const errorRoutes = options.sites
		.filter((site) => !site.upstream)
		.map((site) =>
			compileErrorRoute(
				site.host,
				site.releasePath,
				site.site.notFound ? site.site.notFound : site.site.spa ? '/index.html' : null,
			),
		)
		.filter((route): route is CaddyRoute => route !== null);

	const servers: Record<string, unknown> = {
		content: {
			listen: options.listen,
			...(options.tls ? {} : { automatic_https: { disable: true } }),
			routes: [
				...routes,
				...(options.contentDomain
					? [
							{
								'@id': 'content-placeholder',
								match: [{ host: [options.contentDomain, `*.${options.contentDomain}`] }],
								terminal: true,
								handle: [
									{
										handler: 'static_response',
										status_code: 404,
										body: 'No site at this address.',
									},
								],
							} satisfies CaddyRoute,
						]
					: []),
				{
					'@id': 'catch-all',
					handle: [
						{
							handler: 'static_response',
							status_code: options.catchAllStatus ?? 404,
							body: 'No site at this address.',
						},
					],
				},
			],
			...(errorRoutes.length ? { errors: { routes: errorRoutes } } : {}),
		},
	};

	if (options.tls && (options.tls.httpRedirect ?? true)) {
		servers.http_redirect = {
			listen: [':80'],
			routes: [
				{
					'@id': 'https-redirect',
					handle: [
						{
							handler: 'static_response',
							status_code: 308,
							headers: { Location: ['https://{http.request.host}{http.request.uri}'] },
						},
					],
				},
			],
		};
	}

	return {
		apps: {
			http: { servers },
			...(options.tls ? { tls: tlsApp(options.tls) } : {}),
		},
	};
}

import { join } from 'node:path';
import type { DesiredState, RouteSpec } from '@skiff/contracts';
import {
	compileCaddyConfig,
	type CaddyRoute,
	type SiteCompileInput,
	type TlsOptions,
} from '@skiff/site-config';
import { normalizeHost } from './verify.ts';

/**
 * Adapt the agent protocol's `RouteSpec` to the site-config compiler. Kept separate from `main.ts`
 * so it can be tested without a running agent or Caddy.
 */

export interface CompileAgentConfigOptions {
	state: DesiredState;
	listen: string[];
	dataDir: string;
	agentSocket: string;
	caddyAdminSocket: string;
	/** When present, Caddy manages certs and serves :80 as a redirect. */
	tls?: TlsOptions;
	/** Platform route preserved across full-config reloads. */
	platform?: { host: string; upstream: string };
	/** Caddy JSON access log the agent tails for telemetry (DESIGN §8). */
	accessLog?: string | null;
}

const ACCESS_LOGGER = 'skiff_access';

type DesiredDomain = DesiredState['domains'][number];

interface HttpServerConfig {
	routes: CaddyRoute[];
	[key: string]: unknown;
}

function isSafeProjectId(projectId: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(projectId) && projectId !== '.' && projectId !== '..';
}

/**
 * The production route follows the project's production pointer; every other route is an
 * immutable preview. Older control planes do not send `production`, so fall back to the host.
 */
export function isProductionRoute(route: RouteSpec, contentDomain: string): boolean {
	if (route.production !== undefined) return route.production;
	return normalizeHost(route.host) === normalizeHost(`${route.slug}.${contentDomain}`);
}

/**
 * Where Caddy serves a route from. Production goes through `sites/<projectId>`, a symlink swapped
 * atomically on promote/rollback; previews are rooted at their own content-addressed release, so
 * each preview URL keeps serving exactly the deployment it names (D13).
 */
export function routeRoot(route: RouteSpec, dataDir: string, contentDomain: string): string {
	if (!isSafeProjectId(route.projectId))
		throw new Error(`Invalid project id in desired state: ${route.projectId}`);
	if (!/^[a-f0-9]{64}$/.test(route.release))
		throw new Error(`Invalid release hash in desired state: ${route.release}`);
	return isProductionRoute(route, contentDomain)
		? join(dataDir, 'sites', route.projectId)
		: join(dataDir, 'releases', route.release);
}

export function toSiteCompileInput(
	route: RouteSpec,
	options: Pick<CompileAgentConfigOptions, 'dataDir' | 'agentSocket'> & { contentDomain?: string },
): SiteCompileInput {
	if (!isSafeProjectId(route.projectId))
		throw new Error(`Invalid project id in desired state: ${route.projectId}`);
	return {
		host: route.host,
		projectId: route.projectId,
		deploymentId: route.deploymentId,
		releasePath: routeRoot(route, options.dataDir, options.contentDomain ?? ''),
		agentSocket: route.accessMode === 'public' ? null : options.agentSocket,
		accessMode: route.accessMode,
		site: {
			spa: route.spa,
			cleanUrls: route.cleanUrls,
			trailingSlash: route.trailingSlash,
			notFound: route.notFound,
		},
		redirects: route.redirects,
		headers: route.headers,
		loginUrl: route.access.loginUrl,
		upstream: route.upstream,
	};
}

/** Wildcard plus apex, the minimum a content domain needs for `<slug>.<domain>` sites. */
export function tlsSubjects(contentDomain: string, extraHosts: string[] = []): string[] {
	const domain = contentDomain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
	if (!domain || domain.includes('..') || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain))
		throw new Error(`Invalid content domain for TLS: ${contentDomain}`);
	return [...new Set([`*.${domain}`, domain, ...extraHosts.map((host) => host.trim().toLowerCase())])];
}

/** The route a custom domain clones: the project's `<slug>.<contentDomain>` production route. */
export function productionRouteFor(state: DesiredState, projectId: string): RouteSpec | null {
	return (
		state.routes.find(
			(route) => route.projectId === projectId && isProductionRoute(route, state.contentDomain),
		) ?? null
	);
}

/** Custom domains need on-demand certs; `ask` is only configured when a node actually serves one. */
export function domainsAskUrl(state: Pick<DesiredState, 'platformOrigin' | 'domains'>): string | null {
	if (state.domains.length === 0 || !state.platformOrigin) return null;
	let origin: URL;
	try {
		origin = new URL(state.platformOrigin);
	} catch {
		return null;
	}
	if (origin.protocol !== 'https:' && origin.protocol !== 'http:') return null;
	return `${origin.origin}/api/domains/ask`;
}

function withScheme(target: string): string {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `https://${target}`;
}

/**
 * Old slugs 301 to the renamed project's host. `to` is an origin from the control plane, so the
 * original path and query are appended explicitly rather than relying on Caddy's defaults.
 */
function compileHostRedirect(host: string, to: string): CaddyRoute {
	let destination = to;
	try {
		const url = new URL(to);
		if (url.pathname === '/' && !url.search && !url.hash)
			destination = `${url.origin}{http.request.uri}`;
	} catch {
		// Leave an invalid target as-is; Caddy will report it when the config is loaded.
	}
	return {
		'@id': `redirect:${host}`,
		match: [{ host: [host] }],
		terminal: true,
		handle: [{ handler: 'static_response', headers: { Location: [destination] }, status_code: 301 }],
	};
}

/**
 * A public storage endpoint (S3). Not a site: there is no release, site config or forward_auth,
 * because S3 clients carry no cookies and the SigV4 signature is the access control. Caddy proxies
 * byte-for-byte, keeping `Host` on both hops (SigV4 signs it) and streaming bodies so multipart
 * uploads of many GB pass through without buffering or a size limit.
 */
function compileProxyRoute(id: string, host: string, upstream: string): CaddyRoute {
	return {
		'@id': id,
		match: [{ host: [normalizeHost(host)] }],
		handle: [
			{
				handler: 'reverse_proxy',
				upstreams: [{ dial: upstream.replace(/^https?:\/\//, '') }],
				headers: { request: { set: { Host: ['{http.request.host}'] } } },
				flush_interval: -1,
				transport: {
					protocol: 'http',
					dial_timeout: '30s',
					// Multipart uploads and large downloads must not hit an idle header timeout.
					response_header_timeout: '5m',
				},
				handle_response: [
					{
						match: { status_code: [502, 503, 504] },
						routes: [
							{
								handle: [
									{
										handler: 'static_response',
										status_code: 503,
										headers: { 'Retry-After': ['30'], 'Content-Type': ['text/plain; charset=utf-8'] },
										body: 'This storage endpoint is temporarily unavailable. Please try again shortly.',
									},
								],
							},
						],
					},
				],
			},
		],
	};
}

export function compileStorageRoute(route: DesiredState['storageRoutes'][number]): CaddyRoute {
	return compileProxyRoute(`storage:${route.storageId}`, route.host, route.upstream);
}

/** Only the loopback may carry the internal gateway; a public listener would expose private S3. */
export function isLoopbackListen(listen: string): boolean {
	return /^(127\.0\.0\.1|\[::1\]|localhost):\d{1,5}$/.test(listen);
}

/**
 * Caddy's Caddyfile `redir` directive is sugar for a `static_response` with a Location header;
 * `http.handlers.redir` is not a real JSON module. site-config emits the directive shape, so the
 * agent rewrites it into valid Caddy JSON before loading the config.
 */
function normalizeHandlers(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeHandlers);
	if (typeof value !== 'object' || value === null) return value;

	const record = value as Record<string, unknown>;
	if (record.handler === 'redir') {
		const status = typeof record.status_code === 'number' ? record.status_code : 302;
		const to = typeof record.to === 'string' ? record.to : undefined;
		const normalized: Record<string, unknown> = { handler: 'static_response', status_code: status };
		if (status >= 300 && status < 400 && to !== undefined) normalized.headers = { Location: [to] };
		return normalized;
	}

	const normalized: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(record)) normalized[key] = normalizeHandlers(child);
	return normalized;
}

function caddySocketAddress(socketPath: string): string {
	if (socketPath.includes('|')) return socketPath.startsWith('unix/') ? socketPath : `unix/${socketPath}`;
	const base = socketPath.startsWith('unix/') ? socketPath : `unix/${socketPath}`;
	// Caddy defaults the admin socket to 0200. The agent is a different user, so request group
	// read/write via Caddy's address suffix (the socket is still only reachable on the host).
	return `${base}|0660`;
}

/**
 * Full Caddy config for one reconcile. Caddy reloads its whole config per admin call, so this is
 * applied with a single POST /load (SPIKES §4).
 */
export function buildCaddyConfig(options: CompileAgentConfigOptions): Record<string, unknown> {
	const sites = options.state.routes.map((route) =>
		toSiteCompileInput(route, { ...options, contentDomain: options.state.contentDomain }),
	);
	const siteHosts = new Set(options.state.routes.map((route) => normalizeHost(route.host)));

	// A verified custom host serves exactly the project's production route: same release, site
	// config, access mode and worker upstream, with only the host replaced. `www` siblings are
	// redirects, not clones, so they never serve the site twice.
	for (const domain of options.state.domains) {
		if (domain.redirectTo) continue;
		const host = normalizeHost(domain.host);
		if (siteHosts.has(host)) continue;
		const production = productionRouteFor(options.state, domain.projectId);
		if (!production) continue;
		siteHosts.add(host);
		sites.push(
			toSiteCompileInput(
				// The clone is by definition the production route: `production: true` keeps serving
				// from the project symlink even though the custom host is not `<slug>.<contentDomain>`.
				{ ...production, host: domain.host, production: true },
				{ ...options, contentDomain: options.state.contentDomain },
			),
		);
	}

	const config = compileCaddyConfig({
		listen: options.listen,
		sites,
		catchAllStatus: 404,
		tls: options.tls,
		platform: options.platform,
		contentDomain: options.state.contentDomain,
	});

	const apps = config.apps as
		| { http: { servers: Record<string, HttpServerConfig> }; tls?: Record<string, unknown> }
		| undefined;
	const server = apps?.http.servers.content;
	if (!server) throw new Error('site-config compiler did not produce an HTTP server config');

	const redirects = options.state.hostRedirects
		.filter((redirect) => !siteHosts.has(normalizeHost(redirect.host)))
		.map((redirect) => compileHostRedirect(redirect.host, redirect.to));
	const domainRedirects = options.state.domains
		.filter((domain): domain is DesiredDomain & { redirectTo: string } => Boolean(domain.redirectTo))
		.filter((domain) => !siteHosts.has(normalizeHost(domain.host)))
		.map((domain) => compileHostRedirect(domain.host, withScheme(domain.redirectTo)));
	// Public storage endpoints match on a dedicated host and never collide with site routes (S3).
	const storageRoutes = options.state.storageRoutes.map(compileStorageRoute);
	server.routes = [...storageRoutes, ...redirects, ...domainRedirects, ...server.routes];

	// The control plane's object browser reaches instances through an internal gateway (D82).
	// The edge gets a loopback listener; a worker puts its routes on the WireGuard-only server.
	const gateway = options.state.storageGateway;
	const gatewayRoutes = gateway.routes.map((route) =>
		compileProxyRoute(`gateway:${route.host}`, route.host, route.upstream),
	);
	if (gateway.listen) {
		if (!isLoopbackListen(gateway.listen))
			throw new Error(`storageGateway.listen must be loopback, got "${gateway.listen}"`);
		if (apps) {
			apps.http.servers.storage_gateway = {
				listen: [gateway.listen],
				// The control plane dials this listener over plain HTTP. Host-matched routes would
				// otherwise switch on automatic HTTPS, so Caddy would answer plaintext requests with
				// `400 Client sent an HTTP request to an HTTPS server`.
				automatic_https: { disable: true },
				routes: gatewayRoutes,
				...(server.logs ? { logs: server.logs } : {}),
			};
		}
	} else if (gatewayRoutes.length > 0) {
		server.routes = [...gatewayRoutes, ...server.routes];
	}

	// Only nodes that actually serve custom domains ask the control plane before issuing a cert.
	// `automation.on_demand` only configures the ask endpoint; Caddy also needs an automation
	// policy with `on_demand: true` for the custom hosts. The wildcard policy is left untouched,
	// and the on-demand issuer uses HTTP-01 because a custom domain may live outside the
	// Cloudflare zone that owns the wildcard certificate.
	const ask = domainsAskUrl(options.state);
	if (ask && apps && options.tls) {
		const tls = (apps.tls ??= {});
		const automation = (tls.automation ??= {}) as Record<string, unknown>;
		automation.on_demand = { ask, rate_limit: { interval: '10s', burst: 20 } };
		const policies = (automation.policies as Record<string, unknown>[] | undefined) ?? [];
		policies.push({
			subjects: [...new Set(options.state.domains.map((domain) => domain.host))],
			on_demand: true,
			issuers: [
				{
					module: 'acme',
					email: options.tls.email,
					...(options.tls.ca ? { ca: options.tls.ca } : {}),
				},
			],
		});
		automation.policies = policies;
	}

	if (options.accessLog) {
		// Without a logging app Caddy writes no access log and agent telemetry stays empty (§8).
		// Raw logs stay on the node for 7 days, compressed; only 1-minute aggregates leave it.
		server.logs = {
			default_logger_name: ACCESS_LOGGER,
			...(options.platform ? { skip_hosts: [options.platform.host] } : {}),
		};
		config.logging = {
			logs: {
				default: { exclude: [`http.log.access.${ACCESS_LOGGER}`] },
				[ACCESS_LOGGER]: {
					writer: {
						output: 'file',
						filename: options.accessLog,
						// Readable by the agent through the caddy group; Caddy's default is 0600.
						mode: '0640',
						roll_size_mb: 50,
						roll_gzip: true,
						roll_keep_days: 7,
					},
					encoder: { format: 'json' },
					include: [`http.log.access.${ACCESS_LOGGER}`],
				},
			},
		};
	}

	// Preserve the unix-socket admin endpoint when replacing the config; a full /load without it
	// would let Caddy fall back to its default TCP admin listener (D7).
	config.admin = { listen: caddySocketAddress(options.caddyAdminSocket) };
	return normalizeHandlers(config) as Record<string, unknown>;
}

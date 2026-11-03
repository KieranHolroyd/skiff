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
	const config = compileCaddyConfig({
		listen: options.listen,
		sites: options.state.routes.map((route) =>
			toSiteCompileInput(route, { ...options, contentDomain: options.state.contentDomain }),
		),
		catchAllStatus: 404,
		tls: options.tls,
		platform: options.platform,
		contentDomain: options.state.contentDomain,
	});

	const apps = config.apps as { http: { servers: Record<string, HttpServerConfig> } } | undefined;
	const server = apps?.http.servers.content;
	if (!server) throw new Error('site-config compiler did not produce an HTTP server config');

	const siteHosts = new Set(options.state.routes.map((route) => normalizeHost(route.host)));
	const redirects = options.state.hostRedirects
		.filter((redirect) => !siteHosts.has(normalizeHost(redirect.host)))
		.map((redirect) => compileHostRedirect(redirect.host, redirect.to));
	server.routes = [...redirects, ...server.routes];

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

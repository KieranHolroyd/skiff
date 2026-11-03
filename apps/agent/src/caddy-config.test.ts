import { describe, expect, test } from 'bun:test';
import { desiredStateSchema, type DesiredState } from '@skiff/contracts';
import {
	buildCaddyConfig,
	domainsAskUrl,
	isProductionRoute,
	productionRouteFor,
	tlsSubjects,
	toSiteCompileInput,
} from './caddy-config.ts';

type Json = Record<string, unknown>;

const SHA = 'b'.repeat(64);

function state(): DesiredState {
	return desiredStateSchema.parse({
		version: 12,
		nodeId: 'nod_1',
		agentVersion: '0.1.0',
		generatedAt: '2026-11-03T00:00:00.000Z',
		contentDomain: 'example.com',
		releases: [{ sha256: SHA, url: null, sizeBytes: 1, fileCount: 1, precompressed: true }],
		routes: [
			{
				projectId: 'prj_public',
				slug: 'public',
				host: 'public.example.com',
				deploymentId: 'dep_1',
				release: SHA,
				access: { mode: 'public', siteKey: 'public-site-key-0001', loginUrl: 'https://cloud.example.com/login' },
				accessMode: 'public',
				spa: false,
				cleanUrls: false,
				trailingSlash: 'ignore',
				notFound: null,
				redirects: [],
				headers: [],
			},
			{
				projectId: 'prj_secret',
				slug: 'secret',
				host: 'secret.example.com',
				deploymentId: 'dep_2',
				release: SHA,
				access: { mode: 'password', siteKey: 'secret-site-key-0001', loginUrl: 'https://cloud.example.com/login?project=prj_secret' },
				accessMode: 'password',
				spa: true,
				cleanUrls: true,
				trailingSlash: 'never',
				notFound: '/404.html',
				redirects: [{ from: '/old', to: '/new', status: 301 }],
				headers: [{ path: '/*', headers: { 'X-Test': 'yes' } }],
			},
		],
		revocations: [],
		hostRedirects: [{ host: 'old.example.com', to: 'https://public.example.com' }],
	});
}

function config(stateValue = state()): Json {
	return buildCaddyConfig({
		state: stateValue,
		listen: [':8080'],
		dataDir: '/data',
		agentSocket: '/run/skiff-agent/agent.sock',
		caddyAdminSocket: '/var/lib/caddy/admin.sock',
	});
}

function server(configValue: Json): Json {
	const apps = configValue.apps as Json;
	const http = apps.http as Json;
	const servers = http.servers as Json;
	return servers.content as Json;
}

function routes(configValue: Json): Json[] {
	return server(configValue).routes as Json[];
}

function collectHandlers(value: unknown, output: Json[] = []): Json[] {
	if (Array.isArray(value)) {
		for (const item of value) collectHandlers(item, output);
		return output;
	}
	if (typeof value !== 'object' || value === null) return output;
	const record = value as Json;
	if (typeof record.handler === 'string') output.push(record);
	for (const child of Object.values(record)) collectHandlers(child, output);
	return output;
}

describe('buildCaddyConfig', () => {
	test('keeps the admin API on the unix socket', () => {
		expect(config().admin).toEqual({ listen: 'unix//var/lib/caddy/admin.sock|0660' });
		expect(server(config()).listen).toEqual([':8080']);
	});

	test('puts host redirects before site routes and preserves the path', () => {
		const compiled = routes(config());
		expect(compiled).toHaveLength(5);
		const redirect = compiled[0]!;
		expect(redirect['@id']).toBe('redirect:old.example.com');
		const handlers = redirect.handle as Json[];
		expect(handlers[0]).toEqual({
			handler: 'static_response',
			headers: { Location: ['https://public.example.com{http.request.uri}'] },
			status_code: 301,
		});
		expect(compiled.some((route) => route['@id'] === 'content-placeholder')).toBe(true);
		expect(compiled.at(-1)!['@id']).toBe('catch-all');
	});

	test('adapts a public route to a static file_server', () => {
		const route = routes(config()).find((candidate) => String(candidate['@id']).startsWith('site:prj_public:'));
		expect(route).toBeDefined();
		expect((route!.match as Json[])[0]!.host).toEqual(['public.example.com']);
		const handlers = collectHandlers(route);
		const fileServer = handlers.find((handler) => handler.handler === 'file_server');
		expect(fileServer?.root).toBe('/data/sites/prj_public');
		expect(fileServer?.precompressed).toEqual({ br: {}, gzip: {} });
		expect(handlers.some((handler) => handler.handler === 'reverse_proxy')).toBe(false);
	});

	test('adds forward_auth and site config for a protected route', () => {
		const route = routes(config()).find((candidate) => String(candidate['@id']).startsWith('site:prj_secret:'));
		expect(route).toBeDefined();
		const handlers = collectHandlers(route);
		const proxy = handlers.find((handler) => handler.handler === 'reverse_proxy');
		expect(proxy).toBeDefined();
		expect((proxy!.upstreams as Json[])[0]!.dial).toBe('unix//run/skiff-agent/agent.sock');
		expect((proxy!.rewrite as Json).uri).toBe('/_skiff/verify');
		expect(handlers.some((handler) => handler.handler === 'file_server' && handler.root === '/data/sites/prj_secret')).toBe(true);
		expect(handlers.some((handler) => handler.handler === 'rewrite' && handler.uri === '/index.html')).toBe(true);
		expect(
			handlers.some(
				(handler) =>
					handler.handler === 'static_response' &&
					JSON.stringify(handler.headers).includes('"/new"'),
			),
		).toBe(true);
		expect(handlers.some((handler) => handler.handler === 'headers' && JSON.stringify(handler).includes('X-Test'))).toBe(true);
	});

	test('compiles notFound into an error route', () => {
		const errors = server(config()).errors as Json;
		const errorRoutes = errors.routes as Json[];
		expect(errorRoutes[0]!['@id']).toBe('error:secret.example.com');
		expect(collectHandlers(errorRoutes[0]).some((handler) => handler.handler === 'rewrite' && handler.uri === '/404.html')).toBe(true);
	});

	test('configures ACME DNS-01 and a :80 redirect when TLS is enabled', () => {
		const compiled = buildCaddyConfig({
			state: state(),
			listen: [':443'],
			dataDir: '/data',
			agentSocket: '/run/skiff-agent/agent.sock',
			caddyAdminSocket: '/var/lib/caddy/admin.sock',
			tls: {
				email: 'ops@example.com',
				cloudflareApiToken: 'cf-token',
				subjects: ['*.example.com', 'example.com'],
			},
		});
		const content = server(compiled);
		expect(content.listen).toEqual([':443']);
		expect(content.automatic_https).toBeUndefined();

		const apps = compiled.apps as Json;
		const servers = (apps.http as Json).servers as Json;
		const redirect = servers.http_redirect as Json;
		expect(redirect.listen).toEqual([':80']);
		expect(collectHandlers(redirect).some((handler) => handler.status_code === 308)).toBe(true);

		const tls = apps.tls as Json;
		const automation = tls.automation as Json;
		const policy = (automation.policies as Json[])[0]!;
		expect(policy.subjects).toEqual(['*.example.com', 'example.com']);
		const issuer = (policy.issuers as Json[])[0]!;
		expect(issuer.module).toBe('acme');
		expect(issuer.email).toBe('ops@example.com');
		expect(JSON.stringify(issuer)).toContain('cf-token');
	});

	test('builds wildcard and apex TLS subjects', () => {
		expect(tlsSubjects('Example.COM.')).toEqual(['*.example.com', 'example.com']);
		expect(() => tlsSubjects('bad domain')).toThrow(/Invalid content domain/);
	});

	test('toSiteCompileInput refuses unsafe project ids', () => {
		const route = state().routes[0]!;
		expect(() =>
			toSiteCompileInput({ ...route, projectId: '../escape' }, { dataDir: '/data', agentSocket: '/sock' }),
		).toThrow(/Invalid project id/);
	});
});

describe('per-deployment roots, worker routes and logging', () => {
	const PREVIEW_SHA = 'c'.repeat(64);

	function withPreview(): DesiredState {
		const value = state();
		const production = value.routes[0]!;
		value.routes.push({
			...production,
			host: 'public--abc123.example.com',
			deploymentId: 'dep_preview',
			release: PREVIEW_SHA,
			production: false,
		});
		return value;
	}

	function rootFor(configValue: Json, host: string): unknown {
		const route = routes(configValue).find((item) => JSON.stringify(item.match).includes(`"${host}"`));
		return collectHandlers(route).find((handler) => handler.handler === 'file_server')?.root;
	}

	test('previews serve their own release while production follows the project symlink', () => {
		const compiled = config(withPreview());
		expect(rootFor(compiled, 'public.example.com')).toBe('/data/sites/prj_public');
		expect(rootFor(compiled, 'public--abc123.example.com')).toBe(`/data/releases/${PREVIEW_SHA}`);
	});

	test('derives production from the host when the control plane omits the flag', () => {
		const [production] = state().routes;
		expect(isProductionRoute(production!, 'example.com')).toBe(true);
		expect(isProductionRoute({ ...production!, host: 'public--x1.example.com' }, 'example.com')).toBe(false);
		expect(isProductionRoute({ ...production!, production: false }, 'example.com')).toBe(false);
	});

	test('worker-placed routes proxy and get a branded 503 when the worker is unreachable', () => {
		const value = state();
		value.routes[0] = { ...value.routes[0]!, upstream: 'http://10.8.0.2:8080' };
		const compiled = config(value);
		const errorRoutes = (server(compiled).errors as Json).routes as Json[];
		const unavailable = errorRoutes.find((route) => route['@id'] === 'unavailable:public.example.com');
		expect(unavailable).toBeDefined();
		const response = collectHandlers(unavailable).find((handler) => handler.handler === 'static_response');
		expect(response?.status_code).toBe(503);
		expect((response?.headers as Json)['Retry-After']).toEqual(['30']);
	});

	test('error pages only answer real 404s so protected sites fail closed', () => {
		const errorRoutes = (server(config()).errors as Json).routes as Json[];
		const notFound = errorRoutes.find((route) => route['@id'] === 'error:secret.example.com')!;
		expect(JSON.stringify(notFound.match)).toContain('{http.error.status_code} in [404]');
	});

	test('custom domains clone the production route with the custom host', () => {
		const value = state();
		value.platformOrigin = 'https://cloud.example.com';
		value.domains = [
			{ host: 'app.customer.test', projectId: 'prj_public', kind: 'custom', redirectTo: null },
			{ host: 'secure.customer.test', projectId: 'prj_secret', kind: 'custom', redirectTo: null },
			{ host: 'missing.customer.test', projectId: 'prj_missing', kind: 'custom', redirectTo: null },
		];
		const compiled = config(value);

		const publicRoute = routes(compiled).find((route) =>
			JSON.stringify(route.match).includes('"app.customer.test"'),
		)!;
		expect(publicRoute).toBeDefined();
		expect(publicRoute['@id']).toBe('site:prj_public:dep_1:app.customer.test');
		const publicHandlers = collectHandlers(publicRoute);
		expect(publicHandlers.find((handler) => handler.handler === 'file_server')?.root).toBe('/data/sites/prj_public');
		expect(publicHandlers.some((handler) => handler.handler === 'reverse_proxy')).toBe(false);

		// A protected production route keeps its forward_auth and per-project release root.
		const secureRoute = routes(compiled).find((route) =>
			JSON.stringify(route.match).includes('"secure.customer.test"'),
		)!;
		const secureHandlers = collectHandlers(secureRoute);
		expect((secureHandlers.find((handler) => handler.handler === 'reverse_proxy')?.upstreams as Json[])[0]!.dial).toBe(
			'unix//run/skiff-agent/agent.sock',
		);
		expect(secureHandlers.some((handler) => handler.handler === 'file_server' && handler.root === '/data/sites/prj_secret')).toBe(
			true,
		);

		// No production deployment means no route; the custom host must not be served blindly.
		expect(
			routes(compiled).some((route) => JSON.stringify(route.match ?? null).includes('"missing.customer.test"')),
		).toBe(false);
		expect(routes(compiled).at(-1)!['@id']).toBe('catch-all');
	});

	test('a www sibling 301s to the apex and never serves the site', () => {
		const value = state();
		value.domains = [
			{ host: 'customer.test', projectId: 'prj_public', kind: 'apex', redirectTo: null },
			{ host: 'www.customer.test', projectId: 'prj_public', kind: 'apex', redirectTo: 'customer.test' },
		];
		const compiled = config(value);
		const redirect = routes(compiled).find((route) => route['@id'] === 'redirect:www.customer.test')!;
		expect(redirect).toBeDefined();
		expect(redirect.handle).toEqual([
			{
				handler: 'static_response',
				headers: { Location: ['https://customer.test{http.request.uri}'] },
				status_code: 301,
			},
		]);
		expect(
			routes(compiled).some(
				(route) =>
					route['@id'] !== 'redirect:www.customer.test' &&
					JSON.stringify(route.match ?? null).includes('"www.customer.test"'),
			),
		).toBe(false);

		const apex = routes(compiled).find((route) => route['@id'] === 'site:prj_public:dep_1:customer.test')!;
		expect(apex).toBeDefined();
	});

	test('only nodes serving custom domains configure on-demand TLS with the ask endpoint', () => {
		const tls = {
			email: 'ops@example.com',
			cloudflareApiToken: 'cf-token',
			subjects: ['*.example.com', 'example.com'],
		};

		const noDomains = buildCaddyConfig({
			state: state(),
			listen: [':443'],
			dataDir: '/data',
			agentSocket: '/run/skiff-agent/agent.sock',
			caddyAdminSocket: '/var/lib/caddy/admin.sock',
			tls,
		});
		const noDomainsTls = (noDomains.apps as Json).tls as Json;
		expect((noDomainsTls.automation as Json).on_demand).toBeUndefined();

		const value = state();
		value.platformOrigin = 'https://cloud.example.com';
		value.domains = [{ host: 'app.customer.test', projectId: 'prj_public', kind: 'custom', redirectTo: null }];
		const compiled = buildCaddyConfig({
			state: value,
			listen: [':443'],
			dataDir: '/data',
			agentSocket: '/run/skiff-agent/agent.sock',
			caddyAdminSocket: '/var/lib/caddy/admin.sock',
			tls,
		});
		const automation = ((compiled.apps as Json).tls as Json).automation as Json;
		expect(automation.on_demand).toEqual({
			ask: 'https://cloud.example.com/api/domains/ask',
			rate_limit: { interval: '10s', burst: 20 },
		});
		// The managed wildcard policy is untouched; a separate on-demand policy covers custom hosts.
		const policies = automation.policies as Json[];
		expect(policies[0]!.subjects).toEqual(['*.example.com', 'example.com']);
		expect(policies[0]!.on_demand).toBeUndefined();
		expect(policies[1]).toMatchObject({
			subjects: ['app.customer.test'],
			on_demand: true,
		});
		expect((policies[1]!.issuers as Json[])[0]).toMatchObject({
			module: 'acme',
			email: 'ops@example.com',
		});
		// Custom certs use HTTP-01 (no Cloudflare DNS challenge) so domains outside the zone work.
		expect(JSON.stringify(policies[1]!.issuers)).not.toContain('cloudflare');
	});

	test('domain helpers tolerate missing origins and production routes', () => {
		expect(domainsAskUrl({ domains: [], platformOrigin: 'https://cloud.example.com' })).toBeNull();
		expect(domainsAskUrl({ domains: [{ host: 'a.test', projectId: 'p', kind: 'custom', redirectTo: null }], platformOrigin: 'not a url' })).toBeNull();
		expect(
			domainsAskUrl({
				domains: [{ host: 'a.test', projectId: 'p', kind: 'custom', redirectTo: null }],
				platformOrigin: 'https://cloud.example.com/',
			}),
		).toBe('https://cloud.example.com/api/domains/ask');
		expect(productionRouteFor(state(), 'prj_missing')).toBeNull();
	});

	test('writes a JSON access log for telemetry, skipping the platform host', () => {
		const compiled = buildCaddyConfig({
			state: state(),
			listen: [':8080'],
			dataDir: '/data',
			agentSocket: '/run/skiff-agent/agent.sock',
			caddyAdminSocket: '/var/lib/caddy/admin.sock',
			accessLog: '/var/lib/skiff/caddy/logs/access.log',
			platform: { host: 'cloud.example.com', upstream: 'unix//run/skiff/control.sock' },
		});
		expect(server(compiled).logs).toEqual({
			default_logger_name: 'skiff_access',
			skip_hosts: ['cloud.example.com'],
		});
		const logging = compiled.logging as { logs: Record<string, Json> };
		expect(logging.logs.skiff_access!.writer).toMatchObject({
			output: 'file',
			filename: '/var/lib/skiff/caddy/logs/access.log',
			roll_keep_days: 7,
		});
		expect(logging.logs.skiff_access!.encoder).toEqual({ format: 'json' });
		expect(config().logging).toBeUndefined();
	});
});

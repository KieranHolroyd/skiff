import { describe, expect, test } from 'bun:test';
import { desiredStateSchema, type DesiredState } from '@skiff/contracts';
import {
	buildCaddyConfig,
	customDomainIssuers,
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

	test('serves a default page at a never-deployed project, but never over a real route', () => {
		const value = state();
		value.placeholders = [
			{ host: 'fresh.example.com', projectId: 'prj_fresh', dashboardUrl: 'https://cloud.example.com/projects/fresh' },
			// A stale entry for a host that already has a site route must not shadow it.
			{ host: 'public.example.com', projectId: 'prj_public' },
		];
		const compiled = routes(config(value));
		const placeholders = compiled.filter((route) => String(route['@id']).startsWith('awaiting-deploy:'));
		expect(placeholders.map((route) => route['@id'])).toEqual(['awaiting-deploy:fresh.example.com']);
		const index = compiled.indexOf(placeholders[0]!);
		expect(index).toBeLessThan(compiled.findIndex((route) => route['@id'] === 'content-placeholder'));
		const responses = collectHandlers(placeholders[0]).filter((handler) => handler.handler === 'static_response');
		expect(responses.map((response) => response.status_code)).toEqual([200, 200]);
		expect(String(responses[0]!.body)).toContain('Nothing deployed yet');
		expect(String(responses[0]!.body)).toContain('href="https://cloud.example.com/projects/fresh"');
	});

	test('older control planes send no placeholders', () => {
		expect(routes(config()).some((route) => String(route['@id']).startsWith('awaiting-deploy:'))).toBe(false);
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

	test('verified custom domains get certificates up front, DNS-01 first behind Cloudflare', () => {
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
		const noDomainsAutomation = ((noDomains.apps as Json).tls as Json).automation as Json;
		expect(noDomainsAutomation.policies as Json[]).toHaveLength(1);

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
		// Not on demand: behind the Cloudflare proxy the first request never reaches Caddy without a
		// certificate. Caddy 2.11 also rejects the removed `on_demand.rate_limit` field.
		expect(automation.on_demand).toBeUndefined();
		const policies = automation.policies as Json[];
		expect(policies[0]!.subjects).toEqual(['*.example.com', 'example.com']);
		expect(policies[1]!.subjects).toEqual(['app.customer.test']);
		expect(policies[1]!.on_demand).toBeUndefined();
		const issuers = policies[1]!.issuers as Json[];
		expect(issuers).toHaveLength(2);
		expect(issuers[0]).toMatchObject({
			module: 'acme',
			email: 'ops@example.com',
			challenges: { dns: { provider: { name: 'cloudflare', api_token: 'cf-token' } } },
		});
		// Fallback for domains outside the token's zones: HTTP-01/TLS-ALPN-01.
		expect(issuers[1]).toEqual({ module: 'acme', email: 'ops@example.com' });
		// The custom host is matched by a route, which is what makes Caddy manage its certificate.
		expect(JSON.stringify(routes(compiled))).toContain('"app.customer.test"');
	});

	test('without a Cloudflare token custom domains use HTTP challenges only', () => {
		expect(customDomainIssuers({ email: 'ops@example.com', subjects: [], ca: 'https://acme.test/dir' })).toEqual([
			{ module: 'acme', email: 'ops@example.com', ca: 'https://acme.test/dir' },
		]);
	});

	test('replicated routes carry the cluster health-check interval to Caddy', () => {
		const value = state();
		value.routes[0] = {
			...value.routes[0]!,
			upstreams: ['http://10.88.1.2:8080', 'http://10.88.1.3:8080'],
			healthPath: '/healthz',
			healthIntervalSeconds: 12,
		};
		const json = JSON.stringify(config(value));
		expect(json).toContain('"active":{"uri":"/healthz","interval":"12s"}');
		// An older control plane sends no interval: the agent keeps the 5 s default.
		delete value.routes[0]!.healthIntervalSeconds;
		expect(JSON.stringify(config(value))).toContain('"active":{"uri":"/healthz","interval":"5s"}');
	});

	test('domain helpers tolerate missing origins and production routes', () => {
		expect(productionRouteFor(state(), 'prj_missing')).toBeNull();
	});

	test('public storage endpoints proxy byte-for-byte with no site auth or config', () => {
		const value = state();
		value.storageRoutes = [
			{ storageId: 'st_local', host: 'media--s3.example.com', upstream: '127.0.0.1:19000' },
			{ storageId: 'st_remote', host: 'archive--s3.example.com', upstream: 'http://10.8.0.2:8080' },
		];
		const compiled = routes(config(value));
		const local = compiled.find((route) => route['@id'] === 'storage:st_local')!;
		expect(JSON.stringify(local.match)).toContain('"media--s3.example.com"');

		const proxy = collectHandlers(local).find((handler) => handler.handler === 'reverse_proxy')!;
		expect((proxy.upstreams as Json[])[0]!.dial).toBe('127.0.0.1:19000');
		expect(proxy.flush_interval).toBe(-1);
		expect((proxy.headers as Json).request).toEqual({ set: { Host: ['{http.request.host}'] } });
		// No forward_auth, no file server, no site config: SigV4 is the access control.
		expect(collectHandlers(local).map((handler) => handler.handler)).toEqual(['reverse_proxy', 'static_response']);

		const remote = compiled.find((route) => route['@id'] === 'storage:st_remote')!;
		const remoteProxy = collectHandlers(remote).find((handler) => handler.handler === 'reverse_proxy')!;
		expect((remoteProxy.upstreams as Json[])[0]!.dial).toBe('10.8.0.2:8080');
	});

	test('the edge serves the internal gateway on loopback only', () => {
		const value = state();
		value.storageGateway = {
			listen: '127.0.0.1:8081',
			routes: [
				{ host: 's3-local.storage.internal', upstream: '127.0.0.1:19000' },
				{ host: 's3-remote.storage.internal', upstream: 'http://10.8.0.2:8080' },
			],
		};
		const compiled = config(value);
		const apps = compiled.apps as Json;
		const servers = (apps.http as Json).servers as Json;
		const gateway = servers.storage_gateway as Json;
		expect(gateway.listen).toEqual(['127.0.0.1:8081']);
		// The control plane speaks plain HTTP to the loopback gateway; automatic HTTPS would
		// answer it with a 400 TLS error.
		expect(gateway.automatic_https).toEqual({ disable: true });
		const gatewayRoutes = gateway.routes as Json[];
		expect(gatewayRoutes.map((route) => route['@id'])).toEqual([
			'gateway:s3-local.storage.internal',
			'gateway:s3-remote.storage.internal',
		]);
		const proxy = collectHandlers(gatewayRoutes[1]).find((handler) => handler.handler === 'reverse_proxy')!;
		expect((proxy.upstreams as Json[])[0]!.dial).toBe('10.8.0.2:8080');
		expect((proxy.headers as Json).request).toEqual({ set: { Host: ['{http.request.host}'] } });
		// The public content server must never expose an internal host.
		expect(routes(compiled).some((route) => JSON.stringify(route.match ?? null).includes('storage.internal'))).toBe(
			false,
		);
	});

	test('a worker puts its gateway routes on the WireGuard-only server', () => {
		const value = state();
		value.storageGateway = {
			listen: null,
			routes: [{ host: 's3-local.storage.internal', upstream: '127.0.0.1:19000' }],
		};
		const compiled = config(value);
		const apps = compiled.apps as Json;
		const servers = (apps.http as Json).servers as Json;
		expect(servers.storage_gateway).toBeUndefined();
		expect(routes(compiled)[0]!['@id']).toBe('gateway:s3-local.storage.internal');
	});

	test('refuses a non-loopback gateway listener', () => {
		const value = state();
		value.storageGateway = { listen: ':8081', routes: [] };
		expect(() => config(value)).toThrow(/loopback/);
		value.storageGateway = { listen: '0.0.0.0:8081', routes: [] };
		expect(() => config(value)).toThrow(/loopback/);
	});

	test('the edge serves the database studio gateway on loopback only', () => {
		const value = state();
		value.databaseGateway = {
			listen: '127.0.0.1:8082',
			routes: [{ host: 'n-edge1.studio.internal', upstream: '127.0.0.1:8083' }],
		};
		const compiled = config(value);
		const apps = compiled.apps as Json;
		const servers = (apps.http as Json).servers as Json;
		const gateway = servers.database_gateway as Json;
		expect(gateway.listen).toEqual(['127.0.0.1:8082']);
		expect(gateway.automatic_https).toEqual({ disable: true });
		const gatewayRoutes = gateway.routes as Json[];
		expect(gatewayRoutes.map((route) => route['@id'])).toEqual([
			'gateway:n-edge1.studio.internal',
		]);
		const proxy = collectHandlers(gatewayRoutes[0]).find(
			(handler) => handler.handler === 'reverse_proxy',
		)!;
		expect((proxy.upstreams as Json[])[0]!.dial).toBe('127.0.0.1:8083');
		// The public content server must never expose a studio host.
		expect(
			routes(compiled).some((route) =>
				JSON.stringify(route.match ?? null).includes('studio.internal'),
			),
		).toBe(false);
	});

	test('a worker puts database studio gateway routes on the main server', () => {
		const value = state();
		value.databaseGateway = {
			listen: null,
			routes: [{ host: 'n-edge1.studio.internal', upstream: '127.0.0.1:8083' }],
		};
		const compiled = config(value);
		const apps = compiled.apps as Json;
		const servers = (apps.http as Json).servers as Json;
		expect(servers.database_gateway).toBeUndefined();
		expect(routes(compiled)[0]!['@id']).toBe('gateway:n-edge1.studio.internal');
	});

	test('refuses a non-loopback database studio gateway listener', () => {
		const value = state();
		value.databaseGateway = { listen: ':8082', routes: [] };
		expect(() => config(value)).toThrow(/databaseGateway.*loopback/);
		value.databaseGateway = { listen: '0.0.0.0:8082', routes: [] };
		expect(() => config(value)).toThrow(/databaseGateway.*loopback/);
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

describe('function routes (D110)', () => {
	const FUNCTION_UPSTREAM = 'unix//run/skiff-workloads/prj_public.sock';

	/** A state whose production (`prj_public`) or protected (`prj_secret`) route is a function. */
	function functionState(
		options: {
			assetsDirectory?: string | null;
			runWorkerFirst?: string[];
			protectedRoute?: boolean;
			/** Phase 4: replica sockets for a scaled stateless function. */
			upstreams?: string[];
		} = {},
	): DesiredState {
		const value = state();
		const index = options.protectedRoute ? 1 : 0;
		const route = value.routes[index]!;
		value.routes[index] = {
			...route,
			upstream: `unix//run/skiff-workloads/${route.projectId}.sock`,
			function: {
				assetsDirectory: options.assetsDirectory === undefined ? 'public' : options.assetsDirectory,
				runWorkerFirst: options.runWorkerFirst ?? [],
				...(options.upstreams ? { upstreams: options.upstreams } : {}),
			},
		};
		return value;
	}

	function siteRoute(compiled: Json, host: string): Json {
		const route = routes(compiled).find((candidate) =>
			JSON.stringify(candidate.match ?? null).includes(`"${host}"`),
		);
		expect(route).toBeDefined();
		return route!;
	}

	/** The routes inside the site's `subroute`, in evaluation order. */
	function innerRoutes(route: Json): Json[] {
		const outer = (route.handle as Json[])[0]!;
		expect(outer.handler).toBe('subroute');
		return outer.routes as Json[];
	}

	function handlerNames(route: Json): string[] {
		return innerRoutes(route).map((inner) => String((inner.handle as Json[])[0]!.handler));
	}

	test('assets come first and the function is the fallback', () => {
		const compiled = config(functionState({ runWorkerFirst: ['/api/*'] }));
		const route = siteRoute(compiled, 'public.example.com');

		expect(route['@id']).toBe('site:prj_public:dep_1:public.example.com');
		expect(route.terminal).toBe(true);
		expect(handlerNames(route)).toEqual(['headers', 'reverse_proxy', 'file_server', 'reverse_proxy']);

		const headers = (innerRoutes(route)[0]!.handle as Json[])[0]!;
		const set = (headers.response as Json).set as Json;
		expect(set['Strict-Transport-Security']).toEqual(['max-age=63072000; includeSubDomains']);
		expect(set['X-Content-Type-Options']).toEqual(['nosniff']);
		expect(set['Referrer-Policy']).toEqual(['strict-origin-when-cross-origin']);
		// Public: no noindex/private cache directives.
		expect(set['X-Robots-Tag']).toBeUndefined();
		expect(set['Cache-Control']).toBeUndefined();

		// run_worker_first: a simple glob uses the cheap `path` matcher.
		expect((innerRoutes(route)[1]!.match as Json[])[0]).toEqual({ path: ['/api/*'] });

		const files = innerRoutes(route)[2]!;
		expect((files.match as Json[])[0]).toEqual({
			file: {
				root: '/data/sites/prj_public/public',
				try_files: ['{http.request.uri.path}', '{http.request.uri.path}/index.html'],
				try_policy: 'first_exist',
			},
		});
		expect((files.handle as Json[])[0]).toEqual({
			handler: 'file_server',
			root: '/data/sites/prj_public/public',
			precompressed: { br: {}, gzip: {} },
			precompressed_order: ['br', 'gzip'],
		});

		const proxy = (innerRoutes(route)[3]!.handle as Json[])[0]!;
		expect((proxy.upstreams as Json[])[0]!.dial).toBe(FUNCTION_UPSTREAM);
		expect(proxy.headers).toEqual({
			request: {
				set: {
					'X-Skiff-Internal': ['0'],
					'X-Forwarded-Host': ['{http.request.host}'],
				},
			},
		});
		expect(proxy.transport).toEqual({ protocol: 'http', response_header_timeout: '5m' });
		expect(JSON.stringify(proxy.handle_response)).toContain('"status_code":503');
	});

	test('without an assets directory only the function proxy remains', () => {
		const compiled = config(functionState({ assetsDirectory: null, runWorkerFirst: ['/api/*'] }));
		const route = siteRoute(compiled, 'public.example.com');
		expect(handlerNames(route)).toEqual(['headers', 'reverse_proxy']);

		const proxy = (innerRoutes(route)[1]!.handle as Json[])[0]!;
		expect((proxy.upstreams as Json[])[0]!.dial).toBe(FUNCTION_UPSTREAM);
		expect(((proxy.headers as Json).request as Json).set).toMatchObject({ 'X-Skiff-Internal': ['0'] });
	});

	test('a protected function route authenticates before anything is served', () => {
		const compiled = config(functionState({ protectedRoute: true, runWorkerFirst: ['/api/*'] }));
		const route = siteRoute(compiled, 'secret.example.com');
		expect(handlerNames(route)).toEqual([
			'reverse_proxy',
			'headers',
			'static_response',
			'headers',
			'reverse_proxy',
			'file_server',
			'reverse_proxy',
		]);

		const auth = (innerRoutes(route)[0]!.handle as Json[])[0]!;
		expect((auth.upstreams as Json[])[0]!.dial).toBe('unix//run/skiff-agent/agent.sock');
		expect((auth.rewrite as Json).uri).toBe('/_skiff/verify');
		expect((auth.headers as Json).request).toEqual({
			set: { 'X-Forwarded-Uri': ['{http.request.uri}'], 'X-Skiff-Project': ['{http.request.host}'] },
		});

		const set = (((innerRoutes(route)[1]!.handle as Json[])[0]!.response as Json).set as Json);
		expect(set['X-Robots-Tag']).toEqual(['noindex']);
		expect(set['Cache-Control']).toEqual(['private']);
		// The `_redirects` rule precedes the custom `_headers` rule, as on the static tier.
		expect(innerRoutes(route)[2]!.match).toEqual([{ path: ['/old'] }]);
		expect(
			((innerRoutes(route)[3]!.handle as Json[])[0]!.response as Json).set,
		).toEqual({ 'X-Test': ['yes'] });
		// Production follows the project symlink, previews their own release.
		expect(String(JSON.stringify(innerRoutes(route)[5]!.match))).toContain('/data/sites/prj_secret/public');
	});

	test('exclusion-only globs run the worker everywhere except those paths', () => {
		const compiled = config(functionState({ runWorkerFirst: ['!/assets/*'] }));
		const route = siteRoute(compiled, 'public.example.com');
		expect(handlerNames(route)).toEqual(['headers', 'reverse_proxy', 'file_server', 'reverse_proxy']);
		expect((innerRoutes(route)[1]!.match as Json[])[0]).toEqual({
			not: [{ path: ['/assets/*'] }],
		});
	});

	test('a function route with a custom-domain clone keeps its routing', () => {
		const value = functionState({ runWorkerFirst: ['/api/*'] });
		value.domains = [{ host: 'app.customer.test', projectId: 'prj_public', kind: 'custom', redirectTo: null }];
		const compiled = config(value);
		const clone = siteRoute(compiled, 'app.customer.test');
		expect(clone['@id']).toBe('site:prj_public:dep_1:app.customer.test');
		expect(handlerNames(clone)).toEqual(['headers', 'reverse_proxy', 'file_server', 'reverse_proxy']);
		const proxy = (innerRoutes(clone)[3]!.handle as Json[])[0]!;
		expect(((proxy.headers as Json).request as Json).set).toMatchObject({ 'X-Skiff-Internal': ['0'] });
		expect(String(JSON.stringify(innerRoutes(clone)[2]!.match))).toContain('/data/sites/prj_public/public');
	});

	test('a scaled stateless function proxies to every replica socket in order', () => {
		const replicas = [
			'unix//run/skiff-workloads/wld_public.sock',
			'unix//run/skiff-workloads/wld_public-r1.sock',
			'unix//run/skiff-workloads/wld_public-r2.sock',
		];
		const compiled = config(functionState({ runWorkerFirst: ['/api/*'], upstreams: replicas }));
		const route = siteRoute(compiled, 'public.example.com');
		expect(handlerNames(route)).toEqual(['headers', 'reverse_proxy', 'file_server', 'reverse_proxy']);

		// One reverse_proxy, in list order, on the worker-first hop and the fallback alike.
		const proxies = collectHandlers(route).filter((handler) => handler.handler === 'reverse_proxy');
		expect(proxies).toHaveLength(2);
		for (const proxy of proxies) {
			expect(proxy.upstreams).toEqual(replicas.map((dial) => ({ dial })));
			expect(((proxy.headers as Json).request as Json).set).toMatchObject({ 'X-Skiff-Internal': ['0'] });
			expect((proxy.transport as Json).response_header_timeout).toBe('5m');
			expect(JSON.stringify(proxy.handle_response)).toContain('"status_code":503');
		}
	});

	test('a non-function route is unchanged and every route id stays unique', () => {
		const plain = config();
		const withFunction = config(functionState({ runWorkerFirst: ['/api/*'] }));
		expect(siteRoute(withFunction, 'secret.example.com')).toEqual(siteRoute(plain, 'secret.example.com'));

		const content = server(withFunction);
		const ids = [
			...(content.routes as Json[]).map((route) => route['@id']),
			...((content.errors as Json).routes as Json[]).map((route) => route['@id']),
		].filter((id): id is string => typeof id === 'string');
		expect(new Set(ids).size).toBe(ids.length);
	});
});

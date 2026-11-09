import { describe, expect, test } from 'bun:test';
import type { CaddyHandler, CaddyRoute, SiteCompileInput } from '@yoal/site-config';
import {
	compileFunctionRoute,
	FUNCTION_DIAL_RETRY,
	functionAssetsRoot,
	globToRegExp,
	runWorkerFirstMatch,
} from './function-routing.ts';

function site(overrides: Partial<SiteCompileInput> = {}): SiteCompileInput {
	return {
		host: 'app.example.com',
		projectId: 'prj_app',
		deploymentId: 'dep_1',
		releasePath: '/data/sites/prj_app',
		agentSocket: '/run/yoal-agent/agent.sock',
		accessMode: 'public',
		site: { spa: false, cleanUrls: false, trailingSlash: 'ignore', notFound: null },
		redirects: [],
		headers: [],
		loginUrl: 'https://cloud.example.com/login',
		upstream: 'unix//run/yoal-workloads/prj_app.sock',
		...overrides,
	};
}

describe('run_worker_first globs', () => {
	test('simple globs use the cheap path matcher', () => {
		expect(runWorkerFirstMatch(['/api/*'])).toEqual([{ path: ['/api/*'] }]);
		// The contract allows a glob without a leading slash; Caddy's path matcher does not.
		expect(runWorkerFirstMatch(['api/?'])).toEqual([{ path: ['/api/?'] }]);
	});

	test('each regex family becomes its own matcher set, because Caddy ANDs one set', () => {
		expect(runWorkerFirstMatch(['/api/*', '/**/*.json'])).toEqual([
			{ path: ['/api/*'] },
			{ path_regexp: { pattern: '^/.*/.*\\.json$' } },
		]);
	});

	test('regex-special globs are escaped, so a bundle cannot inject a pattern', () => {
		expect(globToRegExp('/*.json')).toBe('^/.*\\.json$');
		expect(globToRegExp('/a+b')).toBe('^/a\\+b$');
		expect(globToRegExp('/[x](y)$^')).toBe('^/\\[x\\]\\(y\\)\\$\\^$');
		// `**` is one wildcard, not two.
		expect(globToRegExp('/**/x')).toBe('^/.*/x$');
		expect(globToRegExp('/a?b')).toBe('^/a.b$');
	});

	test('a negated glob excludes a path from every positive set', () => {
		expect(runWorkerFirstMatch(['/api/*', '!/api/private/*'])).toEqual([
			{ path: ['/api/*'], not: [{ path: ['/api/private/*'] }] },
		]);
	});

	test('exclusion-only lists run the worker everywhere except those paths', () => {
		expect(runWorkerFirstMatch(['!/static/*'])).toEqual([{ not: [{ path: ['/static/*'] }] }]);
		expect(runWorkerFirstMatch(['!/a/*.json'])).toEqual([
			{ not: [{ path_regexp: { pattern: '^/a/.*\\.json$' } }] },
		]);
	});

	test('an empty list emits no matcher and an empty glob is refused', () => {
		expect(runWorkerFirstMatch([])).toEqual([]);
		expect(() => runWorkerFirstMatch(['!'])).toThrow(/Empty function asset glob/);
	});
});

describe('function route safety', () => {
	test('assets live under the release root and cannot escape it', () => {
		expect(functionAssetsRoot('/data/sites/prj_app', 'public')).toBe('/data/sites/prj_app/public');
		expect(functionAssetsRoot('/data/sites/prj_app', 'app/assets')).toBe('/data/sites/prj_app/app/assets');
		// `.` and `a/./b` stay inside the release; only `..` escapes.
		expect(functionAssetsRoot('/data/sites/prj_app', '.')).toBe('/data/sites/prj_app');
		expect(functionAssetsRoot('/data/sites/prj_app', 'a/./b')).toBe('/data/sites/prj_app/a/b');
		expect(() => functionAssetsRoot('/data/sites/prj_app', '../secrets')).toThrow(/Invalid function assets/);
		expect(() => functionAssetsRoot('/data/sites/prj_app', 'a/../../secrets')).toThrow(/Invalid function assets/);
		expect(() => functionAssetsRoot('/data/sites/prj_app', '/etc')).toThrow(/Invalid function assets/);
	});

	test('a function route without an upstream is refused', () => {
		expect(() =>
			compileFunctionRoute(site({ upstream: null }), { assetsDirectory: null, runWorkerFirst: [] }),
		).toThrow(/no upstream/);
	});
});


describe('replica upstreams (phase 4)', () => {
	const replicas = [
		'unix//run/yoal-workloads/wld_fn.sock',
		'unix//run/yoal-workloads/wld_fn-r1.sock',
		'unix//run/yoal-workloads/wld_fn-r2.sock',
	];

	/** The routes inside the site's `subroute`, in evaluation order. */
	function innerRoutes(route: CaddyRoute): CaddyRoute[] {
		const subroute = route.handle?.[0];
		expect(subroute?.handler).toBe('subroute');
		return (subroute?.routes ?? []) as CaddyRoute[];
	}

	/** The first handler name of each inner route, for order assertions. */
	function handlerNames(route: CaddyRoute): Array<string | undefined> {
		return innerRoutes(route).map((inner) => (inner.handle?.[0] as CaddyHandler | undefined)?.handler as string | undefined);
	}

	function reverseProxy(route: CaddyRoute, index: number) {
		const handler = innerRoutes(route)[index]?.handle?.[0];
		expect(handler?.handler).toBe('reverse_proxy');
		return handler as {
			upstreams: Array<{ dial: string }>;
			headers: { request: { set: Record<string, string[]> } };
			transport: Record<string, unknown>;
			load_balancing: Record<string, unknown>;
			handle_response: unknown;
		};
	}

	test('one reverse_proxy balances the replica sockets in order', () => {
		const route = compileFunctionRoute(site(), {
			assetsDirectory: null,
			runWorkerFirst: [],
			upstreams: replicas,
		});
		// Without assets there is only the security headers route and the function proxy.
		expect(handlerNames(route)).toEqual(['headers', 'reverse_proxy']);

		const proxy = reverseProxy(route, 1);
		expect(proxy.upstreams).toEqual(replicas.map((dial) => ({ dial })));
		// The single-host guarantees survive the list: internal header, timeout and 503 handler.
		expect(proxy.headers).toEqual({
			request: {
				set: {
					'X-Yoal-Internal': ['0'],
					'X-Forwarded-Host': ['{http.request.host}'],
				},
			},
		});
		expect(proxy.transport).toEqual({ protocol: 'http', response_header_timeout: '5m' });
		// A socket that is briefly gone (deploy, watchdog restart) holds the request, not a 503.
		expect(proxy.load_balancing).toEqual({ try_duration: FUNCTION_DIAL_RETRY, try_interval: '250ms' });
		expect(JSON.stringify(proxy.handle_response)).toContain('"status_code":503');
		expect(JSON.stringify(proxy.handle_response)).toContain('Retry-After');
	});

	test('assets-first routing sends every function hop to the same replica list', () => {
		const route = compileFunctionRoute(site(), {
			assetsDirectory: 'public',
			runWorkerFirst: ['/api/*'],
			upstreams: replicas,
		});
		expect(handlerNames(route)).toEqual(['headers', 'reverse_proxy', 'file_server', 'reverse_proxy']);
		// run_worker_first and the fallback use the same ordered list.
		expect(reverseProxy(route, 1).upstreams).toEqual(replicas.map((dial) => ({ dial })));
		expect(reverseProxy(route, 3).upstreams).toEqual(replicas.map((dial) => ({ dial })));
	});

	test('one upstream renders exactly as today', () => {
		const withoutList = compileFunctionRoute(site(), { assetsDirectory: null, runWorkerFirst: [] });
		const withList = compileFunctionRoute(site(), {
			assetsDirectory: null,
			runWorkerFirst: [],
			upstreams: ['unix//run/yoal-workloads/prj_app.sock'],
		});
		expect(withList).toEqual(withoutList);
		// An empty list (older desired state sends none) falls back to the route's own upstream.
		expect(
			compileFunctionRoute(site(), { assetsDirectory: null, runWorkerFirst: [], upstreams: [] }),
		).toEqual(withoutList);
	});

	test('an HTTP target is stripped to Caddy dial form, as site-config does', () => {
		const route = compileFunctionRoute(site(), {
			assetsDirectory: null,
			runWorkerFirst: [],
			upstreams: ['http://10.0.0.5:8080'],
		});
		expect(reverseProxy(route, 1).upstreams).toEqual([{ dial: '10.0.0.5:8080' }]);
	});
});

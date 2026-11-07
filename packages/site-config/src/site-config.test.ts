import { describe, expect, test } from 'bun:test';
import { compileCaddyConfig, compilePattern, compileSiteRoute, compileTarget, parseSiteConfig } from './index.ts';
import type { SiteCompileInput } from './compile.ts';

const file = (text: string) => new TextEncoder().encode(text);

describe('parseSiteConfig', () => {
	test('parses skiff.json, _redirects and _headers', () => {
		const parsed = parseSiteConfig({
			'skiff.json': file(JSON.stringify({ spa: true, cleanUrls: true, trailingSlash: 'never', notFound: '/404.html' })),
			_redirects: file('# comment\n/old /new 301\n/legacy/* /posts/:splat 302\n/api /api.html 200\n'),
			_headers: file('/assets/*\n  Cache-Control: public, max-age=31536000\n  X-Test: yes\n\n/*\n  X-Frame-Options: DENY\n'),
		});
		expect(parsed.config).toEqual({ spa: true, cleanUrls: true, trailingSlash: 'never', notFound: '/404.html' });
		expect(parsed.redirects).toHaveLength(3);
		expect(parsed.redirects[1]).toEqual({ from: '/legacy/*', to: '/posts/:splat', status: 302 });
		expect(parsed.headers[0]?.path).toBe('/assets/*');
		expect(parsed.headers[0]?.headers['X-Test']).toBe('yes');
		expect(parsed.headers[1]?.headers['X-Frame-Options']).toBe('DENY');
	});

	test('defaults are safe (no SPA, no clean URLs)', () => {
		expect(parseSiteConfig({}).config).toEqual({
			spa: false,
			cleanUrls: false,
			trailingSlash: 'ignore',
			notFound: null,
		});
	});

	test('rejects unsupported redirect statuses with a line number', () => {
		expect(() => parseSiteConfig({ _redirects: file('/a /b 999\n') })).toThrow(/999/);
		try {
			parseSiteConfig({ _redirects: file('/a /b 999\n') });
		} catch (error) {
			const issue = (error as { issues: Array<{ line?: number }> }).issues[0];
			expect(issue?.line).toBe(1);
		}
	});

	test('rejects traversal and dangling splats', () => {
		expect(() => parseSiteConfig({ _redirects: file('../etc /x 301\n') })).toThrow();
		expect(() => parseSiteConfig({ _redirects: file('/a/*/b /x 301\n') })).toThrow(/only allowed at the end/);
	});

	test('rejects invalid JSON in skiff.json', () => {
		expect(() => parseSiteConfig({ 'skiff.json': file('{nope') })).toThrow(/Invalid JSON/);
	});

	test('rejects header lines before a path', () => {
		expect(() => parseSiteConfig({ _headers: file('  X-Test: yes\n') })).toThrow(/before any path/);
	});
});

describe('pattern compiler', () => {
	test('literal paths are anchored', () => {
		expect(compilePattern('/about').regex).toBe('^/about$');
		expect(compilePattern('/about').groups).toEqual([]);
	});

	test('placeholders and splats become named groups', () => {
		const compiled = compilePattern('/posts/:id/*');
		expect(compiled.regex).toBe('^/posts/(?P<id>[^/]+)/(?P<splat>.*)$');
		expect(compiled.groups).toEqual([
			{ name: 'id', splat: false },
			{ name: 'splat', splat: true },
		]);
	});

	test('targets become Caddy placeholders', () => {
		expect(compileTarget('/posts/:id')).toBe('/posts/{http.regexp.id}');
		expect(compileTarget('/new/*')).toBe('/new/{http.regexp.splat}');
	});
});

const base: SiteCompileInput = {
	host: 'blog.example.dev',
	projectId: 'prj_1',
	releasePath: '/srv/releases/abc',
	agentSocket: '/run/skiff-agent/agent.sock',
	accessMode: 'public',
	site: { spa: false, cleanUrls: false, trailingSlash: 'ignore', notFound: '/404.html' },
	redirects: [{ from: '/old', to: '/new', status: 301 }],
	headers: [{ path: '/*', headers: { 'X-Frame-Options': 'DENY' } }],
	loginUrl: 'https://control.example.dev/_skiff/site-login',
};

describe('compileSiteRoute', () => {
	test('public sites skip forward_auth', () => {
		const route = compileSiteRoute(base);
		expect(route['@id']).toBe('site:prj_1:blog.example.dev:blog.example.dev');
		expect(route.match).toEqual([{ host: ['blog.example.dev'] }]);
		const json = JSON.stringify(route);
		expect(json).not.toContain('reverse_proxy');
		expect(json).toContain('file_server');
		expect(json).toContain('Strict-Transport-Security');
	});

	test('multi-node replicas list every upstream in one reverse_proxy', () => {
		const route = compileSiteRoute({
			...base,
			upstreams: ['10.88.1.2:8080', '10.88.1.3:8080'],
			healthPath: '/health',
		});
		const json = JSON.stringify(route);
		expect(json).toContain('"dial":"10.88.1.2:8080"');
		expect(json).toContain('"dial":"10.88.1.3:8080"');
		// Caddy's JSON field names; the Caddyfile spellings (`lb_policy`, `health_uri`) are refused
		// as unknown fields and fail the whole config load.
		expect(json).toContain('"load_balancing":{"selection_policy":{"policy":"least_conn"}}');
		expect(json).toContain('"health_checks":{"active":{"uri":"/health","interval":"5s"},"passive":{"fail_duration":"30s"}}');
		expect(json).not.toContain('lb_policy');
		expect(json).not.toContain('health_uri');
	});

	test('protected sites forward_auth to the agent and set noindex/private', () => {
		const route = compileSiteRoute({ ...base, accessMode: 'platform' });
		const json = JSON.stringify(route);
		expect(json).toContain('reverse_proxy');
		expect(json).toContain('/_skiff/verify');
		expect(json).toContain('noindex');
		expect(json).toContain('private');
	});

	test('redirects compile to redir handlers and rewrites to rewrite handlers', () => {
		const route = compileSiteRoute({
			...base,
			redirects: [
				{ from: '/old', to: '/new', status: 301 },
				{ from: '/legacy/*', to: '/posts/:splat', status: 302 },
				{ from: '/api', to: '/api.html', status: 200 },
			],
		});
		const json = JSON.stringify(route);
		expect(json).toContain('"handler":"static_response"');
		expect(json).toContain('"Location":["/posts/{http.regexp.splat}"]');
		expect(json).toContain('"handler":"rewrite"');
	});

	test('SPA and cleanUrls add rewrite routes before the file server', () => {
		const route = compileSiteRoute({ ...base, site: { ...base.site, spa: true, cleanUrls: true } });
		const json = JSON.stringify(route);
		expect(json).toContain('/index.html');
		expect(json).toContain('try_files');
	});

	test('trailing-slash redirects keep the query string', () => {
		const always = JSON.stringify(compileSiteRoute({ ...base, site: { ...base.site, trailingSlash: 'always' } }));
		expect(always).toContain('{http.request.uri.path}/{http.request.uri.prefixed_query}');
		expect(always).not.toContain('{http.request.uri}/');
		const never = JSON.stringify(compileSiteRoute({ ...base, site: { ...base.site, trailingSlash: 'never' } }));
		expect(never).toContain('{http.regexp.skiff_slash.path}{http.request.uri.prefixed_query}');
	});

	test('protected sites never emit public cache headers, even from _headers', () => {
		const json = JSON.stringify(
			compileSiteRoute({
				...base,
				accessMode: 'password',
				headers: [{ path: '/assets/*', headers: { 'Cache-Control': 'public, max-age=600, s-maxage=600' } }],
			}),
		);
		expect(json).not.toContain('public,');
		expect(json).toContain('private, max-age=31536000, immutable');
		expect(json).toContain('private, no-cache');
		expect(json).toContain('"Cache-Control":["private, max-age=600"]');
		// Public sites keep shared caching for hashed assets.
		expect(JSON.stringify(compileSiteRoute(base))).toContain('public, max-age=31536000, immutable');
	});

	test('only hashed files under /assets are cached immutably', () => {
		const route = compileSiteRoute(base);
		const json = JSON.stringify(route);
		expect(json).not.toContain('"/assets/*"');
		const patterns = [...json.matchAll(/"pattern":"((?:[^"\\]|\\.)*)"/g)].map((match) =>
			new RegExp(JSON.parse(`"${match[1]}"`)),
		);
		const immutable = (path: string) => patterns.some((pattern) => pattern.test(path));
		expect(immutable('/assets/index-DiwrgTda.js')).toBe(true);
		expect(immutable('/_astro/hoisted.B9xKz_1q.css')).toBe(true);
		expect(immutable('/static/main.3f9a2b7c.js')).toBe(true);
		expect(immutable('/assets/logo.png')).toBe(false);
		expect(immutable('/assets/hero-image.jpg')).toBe(false);
	});
});

describe('compileCaddyConfig', () => {
	test('emits a catch-all 404, per-site routes and error routes', () => {
		const config = compileCaddyConfig({ listen: [':443'], sites: [base] });
		const json = JSON.stringify(config);
		expect(json).toContain('"@id":"site:prj_1:blog.example.dev:blog.example.dev"');
		expect(json).toContain('"@id":"catch-all"');
		expect(json).toContain('"@id":"error:blog.example.dev"');
		expect(json).toContain('"automatic_https":{"disable":true}');
	});

	test('TLS mode installs a wildcard DNS-01 policy and :80 redirect', () => {
		const config = compileCaddyConfig({
			listen: [':443'],
			sites: [base],
			tls: {
				email: 'ops@example.dev',
				cloudflareApiToken: 'cf-token',
				subjects: ['*.example.dev', 'example.dev'],
			},
		});
		const json = JSON.stringify(config);
		expect(json).toContain('"module":"acme"');
		expect(json).toContain('"name":"cloudflare"');
		expect(json).toContain('"subjects":["*.example.dev","example.dev"]');
		expect(json).toContain('"http_redirect"');
		expect(json).not.toContain('"automatic_https"');
	});

	test('preserves a platform route ahead of content routes', () => {
		const config = compileCaddyConfig({
			listen: [':443'],
			sites: [base],
			platform: { host: 'control.example.dev', upstream: 'unix//run/skiff/control.sock' },
		});
		const json = JSON.stringify(config);
		expect(json).toContain('"@id":"platform"');
		expect(json).toContain('"host":["control.example.dev"]');
		expect(json).toContain('"dial":"unix//run/skiff/control.sock"');
	});
});

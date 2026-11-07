import { describe, expect, test } from 'bun:test';
import { compileCaddyConfig, errorPageHandler, renderErrorPage, type ErrorPageKind } from './index.ts';
import type { SiteCompileInput } from './compile.ts';

type Json = Record<string, unknown>;
const KINDS: ErrorPageKind[] = ['no-site', 'unknown-host', 'not-found', 'unavailable', 'error', 'awaiting-deploy'];

const site: SiteCompileInput = {
	host: 'blog.example.dev',
	projectId: 'prj_1',
	releasePath: '/var/lib/skiff/sites/prj_1',
	accessMode: 'public',
	site: { spa: false, cleanUrls: true, trailingSlash: 'ignore', notFound: null },
	redirects: [],
	headers: [],
	loginUrl: 'https://cloud.example.dev/login',
};

/** Every `{...}` Caddy would treat as a placeholder. */
function placeholders(body: string): string[] {
	return [...body.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]!).filter((key) => /^[a-z]+\.[\w.]+$/.test(key));
}

describe('error pages', () => {
	test('are self-contained HTML documents', () => {
		for (const kind of KINDS) {
			const html = renderErrorPage(kind);
			expect(html.startsWith('<!doctype html>')).toBe(true);
			expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
			expect(html).toContain('<meta name="robots" content="noindex">');
		}
	});

	test('only use error placeholders, never the request host', () => {
		for (const kind of KINDS) {
			for (const key of placeholders(renderErrorPage(kind))) expect(key).toMatch(/^http\.error\.(?:status_code|id)$/);
			expect(renderErrorPage(kind)).not.toContain('{http.request');
		}
		expect(placeholders(renderErrorPage('no-site'))).toEqual([]);
	});

	test('the default page links to the dashboard only with a safe absolute URL', () => {
		expect(renderErrorPage('awaiting-deploy')).not.toContain('Open in dashboard');
		expect(renderErrorPage('awaiting-deploy', { dashboardUrl: 'javascript:alert(1)' })).not.toContain('Open in dashboard');
		const html = renderErrorPage('awaiting-deploy', { dashboardUrl: 'https://cloud.example.dev/projects/{env.SECRET}"x' });
		expect(html).toContain('Open in dashboard');
		expect(html).toContain('skiff deploy');
		// Caller data can never become a Caddy placeholder or break out of the attribute.
		expect(placeholders(html)).toEqual([]);
		expect(html).not.toContain('"x');
	});

	test('negotiate HTML for browsers and plain text otherwise', () => {
		const handler = errorPageHandler('unavailable', 503, { 'Retry-After': ['30'] });
		const [html, text] = handler.routes as Json[];
		expect(html!.match).toEqual([{ header: { Accept: ['*text/html*'] } }]);
		const htmlResponse = (html!.handle as Json[])[0]!;
		const textResponse = (text!.handle as Json[])[0]!;
		expect((htmlResponse.headers as Json)['Content-Type']).toEqual(['text/html; charset=utf-8']);
		expect((textResponse.headers as Json)['Content-Type']).toEqual(['text/plain; charset=utf-8']);
		for (const response of [htmlResponse, textResponse]) {
			expect(response.status_code).toBe(503);
			expect((response.headers as Json)['Retry-After']).toEqual(['30']);
			expect((response.headers as Json)['Cache-Control']).toEqual(['no-store']);
		}
	});

	test('the server always has fallback error routes after per-host ones', () => {
		const config = compileCaddyConfig({ listen: [':443'], sites: [site], contentDomain: 'example.dev' });
		const server = ((config.apps as Json).http as Json).servers as Record<string, Json>;
		const ids = ((server.content!.errors as Json).routes as Json[]).map((route) => route['@id']);
		expect(ids).toEqual(['error-fallback:404', 'error-fallback']);
		const json = JSON.stringify(server.content);
		expect(json).toContain('No site here');
		expect(json).toContain('Domain not connected');
	});
});

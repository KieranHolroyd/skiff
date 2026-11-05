import { describe, expect, test } from 'bun:test';
import { rewriteStudioLocation, studioPath, studioUpstreamPath } from './studio.ts';

describe('studioPath', () => {
	test('builds the platform proxy path and encodes the database name', () => {
		expect(studioPath('app-db')).toBe('/databases/app-db/studio/proxy');
		expect(studioPath('app db')).toBe('/databases/app%20db/studio/proxy');
	});
});

describe('studioUpstreamPath', () => {
	test('joins the gateway web root, rest path and query', () => {
		expect(studioUpstreamPath('/databases/app-db/studio/proxy', '', '')).toBe(
			'/databases/app-db/studio/proxy/'
		);
		expect(studioUpstreamPath('/databases/app-db/studio/proxy/', 'api/tables', '?x=1')).toBe(
			'/databases/app-db/studio/proxy/api/tables?x=1'
		);
	});
});

describe('rewriteStudioLocation', () => {
	const host = 'db-abc.console.internal';

	test('rewrites an absolute internal URL to the platform path', () => {
		expect(
			rewriteStudioLocation(`http://${host}/databases/app-db/studio/proxy/login?next=/`, host)
		).toBe('/databases/app-db/studio/proxy/login?next=/');
	});

	test('rewrites an absolute internal URL with an explicit container port', () => {
		expect(
			rewriteStudioLocation(`http://${host}:3000/databases/app-db/studio/proxy/`, host)
		).toBe('/databases/app-db/studio/proxy/');
	});

	test('keeps relative locations as they are', () => {
		expect(rewriteStudioLocation('/databases/app-db/studio/proxy/', host)).toBe(
			'/databases/app-db/studio/proxy/'
		);
	});

	test('does not rewrite another origin or scheme', () => {
		expect(rewriteStudioLocation('https://example.com/login', host)).toBe(
			'https://example.com/login'
		);
		expect(rewriteStudioLocation(`https://${host}/login`, host)).toBe(`https://${host}/login`);
	});
});

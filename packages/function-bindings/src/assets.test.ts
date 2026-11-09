import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import assetsWorker from './assets.js';

/**
 * Tests for the Yoal assets binding service. Everything runs against an in-process fake of the
 * workerd `disk` service: a directory tree, byte-for-byte files and the DiskDirectory JSON listing
 * for directories. No network and no filesystem.
 */

const ORIGIN = 'https://app.example';
const CACHE_CONTROL = 'public, max-age=0, must-revalidate';

interface DiskFile {
	body: string | Uint8Array;
	etag?: string;
	lastModified?: string;
}

/** A workerd DiskDirectory stand-in: files are bytes, directories are JSON listings. */
class FakeDisk {
	readonly files = new Map<string, DiskFile>();
	readonly directories = new Set<string>(['/']);
	readonly requests: Array<{ method: string; path: string; search: string }> = [];
	failure: Error | null = null;
	failureStatus: number | null = null;

	add(path: string, body: string | Uint8Array, options: Omit<DiskFile, 'body'> = {}): void {
		this.files.set(path, { body, ...options });
		const parts = path.split('/').filter((part) => part.length > 0);
		parts.pop();
		let directory = '';
		for (const part of parts) {
			directory += `/${part}`;
			this.directories.add(directory);
		}
	}

	fetch = async (input: Request | string | URL): Promise<Response> => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
		this.requests.push({ method: (input instanceof Request ? input.method : 'GET').toUpperCase(), path: url.pathname, search: url.search });
		if (this.failure) throw this.failure;
		if (this.failureStatus !== null) return new Response('disk error', { status: this.failureStatus });

		const path = decodeURIComponent(url.pathname);
		const file = this.files.get(path);
		if (file !== undefined) {
			const body = typeof file.body === 'string' ? new TextEncoder().encode(file.body) : file.body;
			const headers = new Headers({ 'content-type': 'application/octet-stream' });
			headers.set('content-length', String(body.byteLength));
			if (file.etag !== undefined) headers.set('etag', file.etag);
			if (file.lastModified !== undefined) headers.set('last-modified', file.lastModified);
			return new Response(body, { headers });
		}
		if (this.directories.has(path)) {
			// A real listing carries entry metadata; the worker must never send it to the user.
			return new Response(JSON.stringify({ entries: [{ name: 'secret.txt', type: 'file' }] }), {
				headers: { 'content-type': 'application/json' },
			});
		}
		return new Response('not found', { status: 404 });
	};
}

type Env = { DISK: FakeDisk; ASSETS_PREFIX?: string };

const worker = assetsWorker as unknown as {
	fetch(request: Request, env: Env): Promise<Response>;
};

function env(disk: FakeDisk, prefix = ''): Env {
	return { DISK: disk, ASSETS_PREFIX: prefix };
}

function request(
	path: string,
	init: { method?: string; headers?: Record<string, string> } = {},
): Request {
	return new Request(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers: init.headers });
}

async function fetchAsset(
	disk: FakeDisk,
	path: string,
	init: { method?: string; headers?: Record<string, string> } = {},
	prefix = '',
): Promise<Response> {
	return worker.fetch(request(path, init), env(disk, prefix));
}

function sha256(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

describe('serving files', () => {
	test('returns the file body, content type, cache control and a content ETag', async () => {
		const disk = new FakeDisk();
		disk.add('/main.css', 'body { color: red; }');

		const response = await fetchAsset(disk, '/main.css');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('body { color: red; }');
		expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8');
		expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL);
		expect(response.headers.get('etag')).toBe(`"${sha256('body { color: red; }')}"`);
		expect(disk.requests).toEqual([{ method: 'GET', path: '/main.css', search: '' }]);
	});

	test('maps the URL path to the disk path and ignores the query string', async () => {
		const disk = new FakeDisk();
		disk.add('/assets/app.js', 'console.log(1)');

		// The query is part of the asset URL (`?v=1`) but never of the disk path.
		const response = await fetchAsset(disk, '/assets/app.js?v=1&x=2');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('console.log(1)');
		// The worker builds a fresh disk URL from the pathname only; the query never reaches it.
		expect(disk.requests).toEqual([{ method: 'GET', path: '/assets/app.js', search: '' }]);
	});

	test('percent-decodes names and re-encodes them for the disk service', async () => {
		const disk = new FakeDisk();
		disk.add('/hello world/ü.txt', 'unicode');

		const response = await fetchAsset(disk, '/hello%20world/%C3%BC.txt');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('unicode');
		expect(disk.requests[0]?.path).toBe('/hello%20world/%C3%BC.txt');
	});

	test('uses the last-modified and size as a weak validator when the disk has no ETag', async () => {
		const disk = new FakeDisk();
		disk.add('/index.html', '<!doctype html>', { lastModified: 'Fri, 06 Nov 2026 12:00:00 GMT' });

		const first = await fetchAsset(disk, '/index.html');
		const etag = first.headers.get('etag');
		expect(etag).toMatch(/^W\/"[0-9a-f]{8}"$/);

		const second = await fetchAsset(disk, '/index.html', { headers: { 'If-None-Match': etag! } });
		expect(second.status).toBe(304);
		expect(await second.text()).toBe('');
	});

	test('passes through an ETag supplied by the disk service', async () => {
		const disk = new FakeDisk();
		disk.add('/app.js', 'x', { etag: '"disk-v1"' });

		const response = await fetchAsset(disk, '/app.js');
		expect(response.headers.get('etag')).toBe('"disk-v1"');
	});
});

describe('directory requests', () => {
	test('serves /index.html for the root without asking for a directory listing', async () => {
		const disk = new FakeDisk();
		disk.add('/index.html', '<!doctype html><title>home</title>');

		const response = await fetchAsset(disk, '/');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('<!doctype html><title>home</title>');
		expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(disk.requests.map((entry) => entry.path)).toEqual(['/index.html']);
	});

	test('serves /dir/index.html for /dir/', async () => {
		const disk = new FakeDisk();
		disk.add('/docs/index.html', '<h1>docs</h1>');

		const response = await fetchAsset(disk, '/docs/');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('<h1>docs</h1>');
		// A trailing slash is already a directory: do not ask for the listing first.
		expect(disk.requests.map((entry) => entry.path)).toEqual(['/docs/index.html']);
	});

	test('falls back to /dir/index.html for extensionless /dir after the exact miss', async () => {
		const disk = new FakeDisk();
		disk.add('/docs/index.html', '<h1>docs</h1>');

		const response = await fetchAsset(disk, '/docs');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('<h1>docs</h1>');
		expect(disk.requests.map((entry) => entry.path)).toEqual(['/docs', '/docs/index.html']);
	});

	test('serves an extensionless file rather than the directory index', async () => {
		const disk = new FakeDisk();
		disk.add('/docs', 'the file named docs');
		disk.add('/docs/index.html', 'the index');

		const response = await fetchAsset(disk, '/docs');
		expect(await response.text()).toBe('the file named docs');
		expect(disk.requests.map((entry) => entry.path)).toEqual(['/docs']);
	});

	test('returns 404 for a directory without index.html instead of a JSON listing', async () => {
		const disk = new FakeDisk();
		disk.directories.add('/empty');
		disk.directories.add('/empty/nested');

		const withSlash = await fetchAsset(disk, '/empty/');
		expect(withSlash.status).toBe(404);
		expect(withSlash.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(await withSlash.text()).toContain('Not Found');
		expect(disk.requests.map((entry) => entry.path)).toEqual(['/empty/index.html']);

		disk.requests.length = 0;
		const withoutSlash = await fetchAsset(disk, '/empty');
		expect(withoutSlash.status).toBe(404);
		expect(await withoutSlash.text()).not.toContain('secret.txt');
		// The listing is recognised as a directory, discarded, and only the index is checked.
		expect(disk.requests.map((entry) => entry.path)).toEqual(['/empty', '/empty/index.html']);
	});

	test('a missing index for a nested extensionless directory is a 404', async () => {
		const disk = new FakeDisk();
		disk.directories.add('/empty/nested');

		const response = await fetchAsset(disk, '/empty/nested');
		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain('entries');
		expect(disk.requests.map((entry) => entry.path)).toEqual(['/empty/nested', '/empty/nested/index.html']);
	});
});

describe('ASSETS_PREFIX', () => {
	test('strips the configured path prefix before the disk lookup', async () => {
		const disk = new FakeDisk();
		disk.add('/main.css', 'p {}');
		disk.add('/docs/index.html', '<h1>docs</h1>');

		expect((await fetchAsset(disk, '/app/main.css', {}, '/app')).status).toBe(200);
		expect(disk.requests[0]?.path).toBe('/main.css');
		expect((await fetchAsset(disk, '/app/docs/', {}, '/app/')).status).toBe(200);
		expect(disk.requests[1]?.path).toBe('/docs/index.html');
	});

	test('treats the prefix itself as the root', async () => {
		const disk = new FakeDisk();
		disk.add('/index.html', 'home');

		const response = await fetchAsset(disk, '/app', {}, '/app');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('home');
		expect(disk.requests[0]?.path).toBe('/index.html');
	});

	test('does not match a prefix that is only a string prefix of the path', async () => {
		const disk = new FakeDisk();
		disk.add('/main.css', 'p {}');

		const response = await fetchAsset(disk, '/application/main.css', {}, '/app');
		expect(response.status).toBe(404);
		expect(disk.requests).toEqual([]);
	});

	test('an empty prefix maps the whole URL path', async () => {
		const disk = new FakeDisk();
		disk.add('/a/b.txt', 'b');
		const response = await fetchAsset(disk, '/a/b.txt', {}, '');
		expect(response.status).toBe(200);
		expect(disk.requests[0]?.path).toBe('/a/b.txt');
	});
});

describe('methods, HEAD and conditional requests', () => {
	test('HEAD returns the file headers with no body', async () => {
		const disk = new FakeDisk();
		disk.add('/app.js', 'console.log(1)');

		const response = await fetchAsset(disk, '/app.js', { method: 'HEAD' });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('');
		expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
		expect(response.headers.get('content-length')).toBe('14');
		expect(response.headers.get('etag')).not.toBeNull();
	});

	test('HEAD on a missing file is a 404 with no body', async () => {
		const disk = new FakeDisk();
		const response = await fetchAsset(disk, '/missing.js', { method: 'HEAD' });
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('');
	});

	test('every method other than GET and HEAD is 405 and never reaches the disk', async () => {
		const disk = new FakeDisk();
		disk.add('/index.html', 'home');

		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
			const response = await fetchAsset(disk, '/index.html', { method });
			expect(response.status).toBe(405);
			expect(response.headers.get('allow')).toBe('GET, HEAD');
		}
		expect(disk.requests).toEqual([]);
	});

	test('If-None-Match matches strongly, weakly, in a list and as *', async () => {
		const disk = new FakeDisk();
		disk.add('/app.js', 'x');
		const first = await fetchAsset(disk, '/app.js');
		const etag = first.headers.get('etag')!;

		for (const header of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
			const response = await fetchAsset(disk, '/app.js', { headers: { 'If-None-Match': header } });
			expect(response.status).toBe(304);
			expect(response.headers.get('etag')).toBe(etag);
			expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL);
		}
	});

	test('a non-matching If-None-Match serves the body', async () => {
		const disk = new FakeDisk();
		disk.add('/app.js', 'x');

		const response = await fetchAsset(disk, '/app.js', { headers: { 'If-None-Match': '"stale"' } });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('x');
	});

	test('Range requests are ignored and return the whole representation', async () => {
		const disk = new FakeDisk();
		disk.add('/video.txt', 'abcdef');

		const response = await fetchAsset(disk, '/video.txt', { headers: { Range: 'bytes=0-2' } });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('abcdef');
		expect(response.headers.get('content-range')).toBeNull();
	});
});

describe('path safety', () => {
	test('rejects dot segments, encoded separators, NUL and dotfiles without touching the disk', async () => {
		const disk = new FakeDisk();
		disk.add('/secret.txt', 'secret');

		// `new URL` already collapses *plain* dot segments (`/%2e%2e/x` becomes `/x`). The cases
		// here survive URL parsing because the separator is encoded too, so the worker is the only
		// thing that can reject them.
		const unsafe = [
			'/%2e%2e%2fsecret.txt',
			'/%2e%2e%5csecret.txt',
			'/..%2fsecret.txt',
			'/%2Fsecret.txt',
			'/a%5Cb',
			'/%00',
			'/.env',
			'/.well-known/security.txt',
			'/a/%2e%2e%2fb',
			'/a%2fb',
		];
		for (const path of unsafe) {
			const response = await fetchAsset(disk, path);
			expect(response.status).toBe(404);
		}
		expect(disk.requests).toEqual([]);
	});

	test('rejects malformed percent-encoding with 400', async () => {
		const disk = new FakeDisk();
		const response = await fetchAsset(disk, '/%ZZ');
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Bad Request');
		expect(disk.requests).toEqual([]);
	});

	test('a literal dot-segment is normalised by the URL parser, not served', async () => {
		const disk = new FakeDisk();
		disk.add('/secret.txt', 'secret');

		// `new URL` collapses `/a/../secret.txt`; the request is for `/secret.txt`, a normal file.
		const response = await fetchAsset(disk, '/a/../secret.txt');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('secret');
		expect(disk.requests.map((entry) => entry.path)).toEqual(['/secret.txt']);
	});

	test('a decoded NUL in a segment is rejected even when it names a real file', async () => {
		const disk = new FakeDisk();
		disk.add('/a\u0000b', 'nul');
		const response = await fetchAsset(disk, '/a%00b');
		expect(response.status).toBe(404);
		expect(disk.requests).toEqual([]);
	});
});

describe('content types', () => {
	test('maps every documented extension and defaults to octet-stream', async () => {
		const cases: Array<[string, string]> = [
			['/a.html', 'text/html; charset=utf-8'],
			['/a.css', 'text/css; charset=utf-8'],
			['/a.js', 'text/javascript; charset=utf-8'],
			['/a.mjs', 'text/javascript; charset=utf-8'],
			['/a.json', 'application/json; charset=utf-8'],
			['/a.txt', 'text/plain; charset=utf-8'],
			['/a.svg', 'image/svg+xml'],
			['/a.png', 'image/png'],
			['/a.jpg', 'image/jpeg'],
			['/a.gif', 'image/gif'],
			['/a.webp', 'image/webp'],
			['/a.avif', 'image/avif'],
			['/a.ico', 'image/x-icon'],
			['/a.woff2', 'font/woff2'],
			['/a.woff', 'font/woff'],
			['/a.ttf', 'font/ttf'],
			['/a.otf', 'font/otf'],
			['/a.wasm', 'application/wasm'],
			['/a.map', 'application/json; charset=utf-8'],
			['/a.xml', 'application/xml; charset=utf-8'],
			['/a.pdf', 'application/pdf'],
			['/LICENSE', 'application/octet-stream'],
			['/a.unknownext', 'application/octet-stream'],
			['/a.JS', 'text/javascript; charset=utf-8'],
			['/dir.d/file', 'application/octet-stream'],
		];
		const disk = new FakeDisk();
		for (const [path] of cases) disk.add(path, 'x');

		for (const [path, contentType] of cases) {
			const response = await fetchAsset(disk, path);
			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toBe(contentType);
		}
	});
});

describe('disk failures', () => {
	test('a throwing disk service becomes 502, not a 404', async () => {
		const disk = new FakeDisk();
		disk.failure = new Error('disk service unavailable');
		const response = await fetchAsset(disk, '/index.html');
		expect(response.status).toBe(502);
		expect(await response.text()).toContain('Bad Gateway');
	});

	test('a 5xx from the disk service becomes 502, not a 404', async () => {
		const disk = new FakeDisk();
		disk.failureStatus = 500;
		const response = await fetchAsset(disk, '/index.html');
		expect(response.status).toBe(502);
		expect(await response.text()).toContain('Bad Gateway');
	});

	test('a missing DISK binding becomes 502', async () => {
		const response = await worker.fetch(request('/index.html'), { ASSETS_PREFIX: '' } as Env);
		expect(response.status).toBe(502);
	});
});

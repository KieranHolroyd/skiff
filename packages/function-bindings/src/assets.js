/**
 * Yoal static-assets binding service (docs/FUNCTIONS.md §4.2, §4.5, D110, FN10).
 *
 * A Worker that implements the Assets binding on top of workerd's `disk` service. The user Worker
 * gets a plain `service` binding named `ASSETS` pointing at this service, so
 * `env.ASSETS.fetch(request)` behaves like Cloudflare's static-assets binding:
 *
 *   GET/HEAD <url> -> the file at the URL's path, or index.html for a directory
 *
 * `env.DISK` is the disk service bound to the release's assets directory. It speaks workerd's
 * DiskDirectory HTTP interface: `GET <path>` returns the file bytes as `application/octet-stream`
 * and a directory returns a JSON listing. This service never forwards a listing: a directory is
 * only useful as a cue to fall back to `index.html`.
 *
 * Caddy serves assets first from the same release directory (docs/FUNCTIONS.md §4.2), so the cache
 * headers here are deliberately weak (`max-age=0, must-revalidate`); the Caddy tier owns real
 * caching. Range requests are ignored and always return the whole representation.
 *
 * Protocol shape adapted from Miniflare (Apache-2.0), cloudflare/workers-sdk
 * (`packages/miniflare/src/workers/assets`), whose assets simulator implements the same
 * DiskDirectory layout behind `env.ASSETS.fetch()`.
 *
 * Plain JavaScript ESM: workerd loads this file as text and embeds it as a module. No imports, no
 * Node APIs, no eval, only Web APIs.
 */

const CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const INDEX_FILE = 'index.html';
const DISK_ORIGIN = 'https://assets';

/** Extension -> Content-Type. Everything unlisted is `application/octet-stream`. */
const CONTENT_TYPES = Object.freeze({
	html: 'text/html; charset=utf-8',
	htm: 'text/html; charset=utf-8',
	css: 'text/css; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	mjs: 'text/javascript; charset=utf-8',
	json: 'application/json; charset=utf-8',
	map: 'application/json; charset=utf-8',
	txt: 'text/plain; charset=utf-8',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	ico: 'image/x-icon',
	woff2: 'font/woff2',
	woff: 'font/woff',
	ttf: 'font/ttf',
	otf: 'font/otf',
	wasm: 'application/wasm',
	xml: 'application/xml; charset=utf-8',
	pdf: 'application/pdf',
});

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

function contentTypeFor(path) {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	if (dot <= 0) return DEFAULT_CONTENT_TYPE;
	return CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

/** Manifest/worker-controlled prefix: `/app/` and `/app` both mean "strip the `/app` segment". */
function assetsPrefix(value) {
	if (typeof value !== 'string' || value.length === 0) return '';
	const withSlash = value.startsWith('/') ? value : `/${value}`;
	const trimmed = withSlash.replace(/\/+$/, '');
	return trimmed === '' ? '' : trimmed;
}

/**
 * Strip the configured path prefix. The match is segment-aware, so `/app` does not swallow
 * `/application`. A request outside the prefix is not an asset and gets the same 404 as a miss.
 */
function stripPrefix(pathname, prefix) {
	if (prefix === '') return pathname;
	if (pathname === prefix) return '/';
	if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
	return null;
}

/**
 * Decode one URL path into disk-safe segments.
 *
 * Percent-decoding happens **before** the checks, so `%2e%2e`, `%2f` and `%00` cannot smuggle a
 * dot segment, a path separator or a NUL past them. We re-encode each segment when building the
 * disk URL, which also stops a double-encoded value from being decoded a second time by the disk
 * service. Returns an HTTP status on rejection: 400 for malformed escapes, 404 for anything that
 * could address a file outside the assets root or a dotfile.
 */
function decodePath(pathname) {
	if (typeof pathname !== 'string' || !pathname.startsWith('/')) return { status: 404 };
	const trailingSlash = pathname.endsWith('/');
	const raw = pathname.split('/');
	raw.shift();
	if (trailingSlash) raw.pop();

	const segments = [];
	for (const part of raw) {
		// `//` and a trailing slash are both harmless; collapse the empty segment.
		if (part === '') continue;
		let segment;
		try {
			segment = decodeURIComponent(part);
		} catch {
			return { status: 400 };
		}
		if (segment.includes('\u0000')) return { status: 404 };
		// `.` and `..` are navigation, not names; a decoded separator would let a value that
		// looks like one segment become two inside the disk service.
		if (segment === '.' || segment === '..') return { status: 404 };
		if (segment.includes('/') || segment.includes('\\')) return { status: 404 };
		// Dotfiles never leave the release directory, including `.env` and `.well-known`.
		if (segment.startsWith('.')) return { status: 404 };
		segments.push(segment);
	}
	return { segments, trailingSlash };
}

/** The disk service sees a path we built from already-decoded, re-encoded segments. */
function diskPath(segments) {
	return `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

function isDirectoryListing(response) {
	if (!response.ok) return false;
	const type = (response.headers.get('content-type') ?? '').toLowerCase();
	return type.startsWith('application/json') || type.startsWith('text/json');
}

function discard(response) {
	try {
		const body = response.body;
		// A body we already read (to hash it) is locked; there is nothing left to cancel.
		if (body !== null && !body.locked) void body.cancel().catch(() => {});
	} catch {
		// A body that cannot be cancelled is already spent; nothing to clean up.
	}
}

/** HEAD must carry the same headers as GET but no body, including for 4xx responses. */
function withoutBodyForHead(method, response) {
	if (method !== 'HEAD' || response.body === null) return response;
	discard(response);
	return new Response(null, { status: response.status, headers: response.headers });
}

async function readFromDisk(env, path) {
	const response = await env.DISK.fetch(new Request(`${DISK_ORIGIN}${path}`, { method: 'GET', redirect: 'manual' }));
	if (response.status >= 500) {
		// A disk that answers 5xx is broken, not a missing file; the caller turns this into 502.
		discard(response);
		throw new Error(`disk service answered ${response.status}`);
	}
	return response;
}

/** A file response, or null when the path is missing or still a directory. */
async function fileAt(env, path) {
	const response = await readFromDisk(env, path);
	if (!response.ok || isDirectoryListing(response)) {
		discard(response);
		return null;
	}
	return { response, path };
}

/**
 * Resolve a request path to a file:
 * - `/` and `/dir/` are directories: try `index.html` only.
 * - `/dir` tries the exact file first (an extensionless asset), then `/dir/index.html`.
 * - A directory listing is never a result; the index fallback is the only use of a directory.
 */
async function findFile(env, segments, trailingSlash) {
	const base = diskPath(segments);
	const index = base === '/' ? `/${INDEX_FILE}` : `${base}/${INDEX_FILE}`;
	if (trailingSlash) return fileAt(env, index);
	const exact = await readFromDisk(env, base);
	if (exact.ok && !isDirectoryListing(exact)) return { response: exact, path: base };
	discard(exact);
	return fileAt(env, index);
}

function notFound() {
	return new Response('Not Found\n', {
		status: 404,
		headers: { 'Content-Type': 'text/plain; charset=utf-8' },
	});
}

function badRequest() {
	return new Response('Bad Request\n', {
		status: 400,
		headers: { 'Content-Type': 'text/plain; charset=utf-8' },
	});
}

function methodNotAllowed() {
	return new Response('Method Not Allowed\n', {
		status: 405,
		headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' },
	});
}

function badGateway() {
	return new Response('Bad Gateway\n', {
		status: 502,
		headers: { 'Content-Type': 'text/plain; charset=utf-8' },
	});
}

/** FNV-1a over a short string; only used to fold a size+mtime pair into a compact weak ETag. */
function shortHash(value) {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

function quoteEtag(value) {
	const trimmed = value.trim();
	if (trimmed === '') return null;
	if (trimmed.startsWith('W/"')) return trimmed;
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed;
	return `"${trimmed.replace(/"/g, '')}"`;
}

/**
 * A validator from metadata when the disk service supplies one. Size+mtime is enough for a
 * correct revalidation (the disk service only sets it when both are known); otherwise the body
 * hash computed in `respondWithFile` is the fallback.
 */
function metadataEtag(path, response) {
	const provided = response.headers.get('etag');
	if (provided !== null) {
		const quoted = quoteEtag(provided);
		if (quoted !== null) return quoted;
	}
	const lastModified = response.headers.get('last-modified') ?? response.headers.get('x-last-modified');
	const length = response.headers.get('content-length');
	if (lastModified === null || length === null) return null;
	return `W/"${shortHash(`${path}\u0000${length}\u0000${lastModified}`)}"`;
}

async function sha256Hex(bytes) {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	let out = '';
	for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, '0');
	return out;
}

function weakValue(etag) {
	return etag.startsWith('W/') ? etag.slice(2) : etag;
}

/** RFC 9110 If-None-Match: `*`, a comma-separated list, and weak comparison for GET/HEAD. */
function etagMatches(header, etag) {
	const expected = weakValue(etag);
	for (const candidate of header.split(',')) {
		const value = candidate.trim();
		if (value === '*') return true;
		if (weakValue(value) === expected) return true;
	}
	return false;
}

async function respondWithFile(request, found) {
	const { response: diskResponse, path } = found;
	const headers = new Headers();
	headers.set('Content-Type', contentTypeFor(path));
	headers.set('Cache-Control', CACHE_CONTROL);
	const length = diskResponse.headers.get('content-length');
	if (length !== null) headers.set('Content-Length', length);

	let etag = metadataEtag(path, diskResponse);
	let bytes = null;
	// A missing validator means we must read the body to hash it. A metadata validator avoids
	// that read entirely and lets the body stream through on a 200.
	if (etag === null) {
		bytes = new Uint8Array(await diskResponse.arrayBuffer());
		etag = `"${await sha256Hex(bytes)}"`;
		headers.set('Content-Length', String(bytes.byteLength));
	}
	headers.set('ETag', etag);

	const ifNoneMatch = request.headers.get('if-none-match');
	if (ifNoneMatch !== null && etagMatches(ifNoneMatch, etag)) {
		discard(diskResponse);
		return new Response(null, { status: 304, headers });
	}
	if (request.method === 'HEAD') {
		discard(diskResponse);
		return new Response(null, { status: 200, headers });
	}
	return new Response(bytes ?? diskResponse.body, { status: 200, headers });
}

export default {
	/**
	 * `env.DISK`: the workerd disk service for the release's assets directory.
	 * `env.ASSETS_PREFIX`: optional request-path prefix to strip before the disk lookup.
	 */
	async fetch(request, env) {
		const method = request.method.toUpperCase();
		if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed();

		const url = new URL(request.url);
		const stripped = stripPrefix(url.pathname, assetsPrefix(env.ASSETS_PREFIX));
		if (stripped === null) return withoutBodyForHead(method, notFound());

		const decoded = decodePath(stripped);
		if (decoded.status === 400) return withoutBodyForHead(method, badRequest());
		if (decoded.status !== undefined) return withoutBodyForHead(method, notFound());

		let found;
		try {
			found = await findFile(env, decoded.segments, decoded.trailingSlash);
		} catch {
			// A missing or broken disk service is a node problem, not a 404 for the user.
			return withoutBodyForHead(method, badGateway());
		}
		if (found === null) return withoutBodyForHead(method, notFound());
		return respondWithFile(request, found);
	},
};

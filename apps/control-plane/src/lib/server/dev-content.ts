import { eq } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { deployments, releases } from '@skiff/db';
import { contentUrl } from '@skiff/contracts';
import { hmac, safeEqual } from '@skiff/core';
import { compilePattern } from '@skiff/site-config';
import type { RequestEvent } from '@sveltejs/kit';
import { platformOrigin } from './config.js';
import { core } from './core.js';

/**
 * Development-only content hosting.
 *
 * Production serves `<slug>.<contentDomain>` from the node agent + Caddy. On a dev machine there
 * is no Caddy, so `bun run dev` answers the same hosts from the local object store instead: the
 * dashboard's preview links (`<slug>--<id>.localhost:5173`) open the real deployed files, with the
 * same SPA/clean-URL/redirect/header rules the agent compiles.
 *
 * Never enabled in production, and only for `*.localhost` hosts (RFC 6761 loopback), so a public
 * content domain can never be served by the control plane.
 */
const COOKIE_NAME = '__skiff_dev_site';
/** A handful of recent deploys is plenty; releases are immutable and content-addressed. */
const MAX_CACHED_RELEASES = 8;
const filesByRelease = new Map<string, Map<string, Uint8Array>>();

const CONTENT_TYPES: Record<string, string> = {
	html: 'text/html; charset=utf-8',
	htm: 'text/html; charset=utf-8',
	css: 'text/css; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	mjs: 'text/javascript; charset=utf-8',
	json: 'application/json; charset=utf-8',
	map: 'application/json; charset=utf-8',
	txt: 'text/plain; charset=utf-8',
	md: 'text/markdown; charset=utf-8',
	csv: 'text/csv; charset=utf-8',
	xml: 'application/xml; charset=utf-8',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	ico: 'image/x-icon',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	otf: 'font/otf',
	wasm: 'application/wasm',
	pdf: 'application/pdf',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mp3: 'audio/mpeg',
	ogg: 'audio/ogg',
	zip: 'application/zip',
	webmanifest: 'application/manifest+json'
};

export function isDevContentHost(hostname: string): boolean {
	if (process.env.NODE_ENV === 'production') return false;
	const host = hostname.toLowerCase().replace(/\.$/, '');
	if (!host.endsWith('.localhost')) return false;
	// The platform itself may live on a *.localhost host in dev; never intercept the dashboard.
	try {
		if (new URL(platformOrigin).hostname.toLowerCase() === host) return false;
	} catch {
		// Build-time placeholder origin: treat every *.localhost host as content.
	}
	return true;
}

/** Serve a dev content host. */
export async function serveDevContent(event: RequestEvent): Promise<Response> {
	const host = event.url.hostname.toLowerCase().replace(/\.$/, '');
	const route = core.access.resolveContentHost(host);
	if (!route) return text(`Unknown host: ${host}`, 404);

	const siteKey = core.access.siteKeyFor(route.project);
	const now = Math.floor(Date.now() / 1000);

	if (event.url.pathname === '/_skiff/callback')
		return redeemCallback(event, route.project.id, host, siteKey, now);

	if (route.access !== 'public') {
		const cookie = cookieValue(event.request.headers.get('cookie'), COOKIE_NAME);
		if (!cookie || !verifySiteCookie(cookie, siteKey, host, now)) {
			const login = new URL('/_skiff/site-login', platformOrigin);
			login.searchParams.set('project', route.project.id);
			login.searchParams.set('return', `${contentUrl(platformOrigin, host)}${event.url.pathname}${event.url.search}`);
			return new Response(null, {
				status: 303,
				headers: { location: login.toString(), 'cache-control': 'no-store' }
			});
		}
	}

	if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
		return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
	}

	return serveFile(event, route.deploymentId, route.access !== 'public');
}

function redeemCallback(
	event: RequestEvent,
	projectId: string,
	host: string,
	siteKey: string,
	now: number
): Response {
	const token = event.url.searchParams.get('token');
	if (!token) return text('Missing token', 400);
	const claims = core.access.verifySiteToken(projectId, token);
	if (!claims) return text('Invalid or expired token', 403);
	if (claims.host.split(':')[0]!.toLowerCase() !== host) return text('Token is for a different host', 403);
	const sessionExpiry = claims.sexp;
	if (typeof sessionExpiry !== 'number' || sessionExpiry <= now) return text('Session has expired', 403);

	const sid = claims.sid ?? '-';
	const signature = hmac(siteKey, `${host}|${sessionExpiry}|${sid}`);
	const cookie = `${COOKIE_NAME}=${sessionExpiry}.${sid}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, sessionExpiry - now)}`;
	return new Response(null, {
		status: 303,
		headers: { location: '/', 'cache-control': 'no-store', 'set-cookie': cookie }
	});
}

async function serveFile(
	event: RequestEvent,
	deploymentId: string,
	protectedSite: boolean
): Promise<Response> {
	const deployment = core.ctx.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();
	if (!deployment) return text('Deployment not found', 404);
	const release = core.ctx.db.select().from(releases).where(eq(releases.id, deployment.releaseId)).get();
	if (!release) return text('Release not found', 404);

	const files = await loadRelease(release.sha256, release);
	const config = core.deployments.configFor(deployment);
	const method = event.request.method;

	let pathname: string;
	try {
		pathname = decodeURIComponent(event.url.pathname);
	} catch {
		return text('Bad request', 400);
	}
	if (pathname.includes('\0') || pathname.split('/').some((part) => part === '..')) return text('Bad request', 400);

	// `_redirects`: first matching rule wins, exactly like the agent's Caddy route order.
	for (const redirect of config.redirects) {
		const values = matchPattern(redirect.from, pathname);
		if (!values) continue;
		const target = expandTarget(redirect.to, values);
		if (redirect.status === 200) {
			pathname = target.split('?')[0]!;
			break;
		}
		if (redirect.status >= 300 && redirect.status < 400)
			return redirectTo(trackStatus(target, event.url.search), redirect.status);
		return new Response('', { status: redirect.status });
	}

	if (config.config.trailingSlash === 'always' && pathname !== '/' && !pathname.endsWith('/') && !hasExtension(pathname)) {
		return redirectTo(`${pathname}/${event.url.search}`, 308);
	}
	if (config.config.trailingSlash === 'never' && pathname !== '/' && pathname.endsWith('/')) {
		return redirectTo(`${pathname.replace(/\/+$/, '')}${event.url.search}`, 308);
	}

	let file = findFile(files, pathname);
	if (!file && config.config.cleanUrls) {
		file = findFile(files, `${pathname}.html`) ?? findFile(files, `${pathname}/index.html`);
	}
	if (
		!file &&
		config.config.spa &&
		!hasExtension(pathname) &&
		!pathname.startsWith('/_app/') &&
		!pathname.startsWith('/assets/')
	) {
		file = findFile(files, '/index.html');
	}

	let status = 200;
	if (!file && config.config.notFound) {
		file = findFile(files, config.config.notFound);
		if (file) status = 404;
	}
	if (!file) return text('Not found', 404);

	const headers = new Headers({
		'content-type': contentType(file.key),
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'strict-origin-when-cross-origin',
		'cache-control': protectedSite ? 'private, no-cache' : 'no-cache',
		...(protectedSite ? { 'x-robots-tag': 'noindex' } : {})
	});
	for (const rule of config.headers) {
		if (!matchPattern(rule.path, pathname)) continue;
		for (const [name, value] of Object.entries(rule.headers))
			headers.set(name, protectedSite && name.toLowerCase() === 'cache-control' ? privateCacheControl(value) : value);
	}

	return new Response(method === 'HEAD' ? null : (file.data as unknown as BodyInit), { status, headers });
}

interface ServedFile {
	key: string;
	data: Uint8Array;
}

function findFile(files: Map<string, Uint8Array>, pathname: string): ServedFile | null {
	const key = pathname.replace(/^\/+/, '');
	const candidates = key === '' || key.endsWith('/') ? [`${key}index.html`] : [key, `${key}/index.html`];
	for (const candidate of candidates) {
		const data = files.get(candidate);
		if (data) return { key: candidate, data };
	}
	return null;
}

async function loadRelease(sha256: string, release: { objectKey: string }): Promise<Map<string, Uint8Array>> {
	const cached = filesByRelease.get(sha256);
	if (cached) {
		// Refresh LRU order.
		filesByRelease.delete(sha256);
		filesByRelease.set(sha256, cached);
		return cached;
	}
	const zip = await core.releases.download(release);
	const unzipped = unzipSync(zip);
	const files = new Map<string, Uint8Array>();
	for (const [rawPath, data] of Object.entries(unzipped)) {
		if (rawPath.endsWith('/')) continue;
		const path = rawPath.replaceAll('\\', '/').replace(/^\.\//, '');
		if (!path || path.split('/').some((part) => part === '..' || part === '.DS_Store')) continue;
		files.set(path, data);
	}
	filesByRelease.set(sha256, files);
	if (filesByRelease.size > MAX_CACHED_RELEASES) {
		const oldest = filesByRelease.keys().next().value;
		if (oldest) filesByRelease.delete(oldest);
	}
	return files;
}

function cookieValue(header: string | null, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(';')) {
		const [key, ...rest] = part.trim().split('=');
		if (key === name) return rest.join('=');
	}
	return null;
}

function verifySiteCookie(value: string, siteKey: string, host: string, now: number): boolean {
	const [expRaw, sid, signature] = value.split('.');
	if (!expRaw || !sid || !signature) return false;
	const exp = Number(expRaw);
	if (!Number.isFinite(exp) || exp <= now) return false;
	return safeEqual(hmac(siteKey, `${host}|${exp}|${sid}`), signature);
}

/** Netlify-style `_redirects` patterns, compiled by the same helper the agent uses. */
function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
	const compiled = compilePattern(pattern);
	if (compiled.error) return null;
	const match = new RegExp(compiled.regex).exec(pathname);
	if (!match) return null;
	const values: Record<string, string> = {};
	for (const group of compiled.groups) values[group.name] = match.groups?.[group.name] ?? '';
	return values;
}

function expandTarget(target: string, values: Record<string, string>): string {
	return target
		.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => values[name] ?? '')
		.replace(/\*/g, values.splat ?? '');
}

function redirectTo(location: string, status: number): Response {
	return new Response(null, { status, headers: { location, 'cache-control': 'no-store' } });
}

/** Keep the request's query string when a redirect target has none of its own. */
function trackStatus(target: string, search: string): string {
	return target.includes('?') || !search ? target : `${target}${search}`;
}

function hasExtension(pathname: string): boolean {
	return /\.[a-zA-Z0-9]{1,8}$/.test(pathname);
}

/** Mirrors the agent: a `_headers` Cache-Control may tune lifetime but never make a site public. */
function privateCacheControl(value: string): string {
	const directives = value
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part && !/^(?:public|private)$/i.test(part) && !/^s-maxage=/i.test(part));
	return ['private', ...directives].join(', ');
}

function contentType(key: string): string {
	const dot = key.lastIndexOf('.');
	const extension = dot === -1 ? '' : key.slice(dot + 1).toLowerCase();
	return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

function text(body: string, status: number): Response {
	return new Response(body, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
	});
}

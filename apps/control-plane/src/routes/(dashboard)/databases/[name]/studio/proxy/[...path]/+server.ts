import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { rewriteStudioLocation, studioUpstreamPath } from '../../../_lib/studio.js';

/**
 * Same-origin proxy for the on-demand DBGate studio. The platform session is the authentication;
 * DBGate's per-session HTTP Basic password is injected here and never reaches the browser.
 */

/** Headers DBGate needs to answer the request. Everything else stays on the platform origin. */
const FORWARD_REQUEST_HEADERS = [
	'content-type',
	'accept',
	'range',
	'if-match',
	'if-none-match',
	'if-modified-since',
	'if-unmodified-since',
	'if-range'
] as const;

/** Only response headers that are safe for the dashboard origin to expose. */
const FORWARD_RESPONSE_HEADERS = [
	'content-type',
	'content-length',
	'cache-control',
	'etag',
	'last-modified',
	'content-disposition'
] as const;

const proxy: RequestHandler = (event) =>
	route(async () => {
		const principal = event.locals.principal;
		if (!principal) {
			return new Response('Unauthorized', {
				status: 401,
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			});
		}

		const rest = event.params.path ?? '';
		if (rest.split('/').some((segment) => segment === '.' || segment === '..')) {
			return new Response('Bad request', {
				status: 400,
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			});
		}

		// Enforces database:console and the console lifecycle, and yields the internal gateway host.
		const endpoint = core.databases.consoleEndpoint(principal, event.params.name);
		const port = core.ctx.config.databaseGatewayPort ?? 8082;
		const target = `http://127.0.0.1:${port}${studioUpstreamPath(
			endpoint.webRoot,
			event.params.path,
			event.url.search
		)}`;

		const headers = new Headers({
			host: endpoint.host,
			authorization: endpoint.authHeader,
			// Never let the gateway compress: we forward the body untouched.
			'accept-encoding': 'identity'
		});
		for (const name of FORWARD_REQUEST_HEADERS) {
			const value = event.request.headers.get(name);
			if (value !== null) headers.set(name, value);
		}

		const method = event.request.method;
		const init: RequestInit & { duplex?: 'half' } = {
			method,
			headers,
			// DBGate redirects internally; hand the Location back to the browser (rewritten below).
			redirect: 'manual',
			signal: event.request.signal
		};
		if (method !== 'GET' && method !== 'HEAD' && event.request.body) {
			init.body = event.request.body;
			init.duplex = 'half';
		}

		let upstream: Response;
		try {
			upstream = await fetch(target, init);
		} catch {
			return new Response('The database studio is unavailable.', {
				status: 503,
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'cache-control': 'no-store'
				}
			});
		}

		const responseHeaders = new Headers();
		for (const name of FORWARD_RESPONSE_HEADERS) {
			const value = upstream.headers.get(name);
			if (value !== null) responseHeaders.set(name, value);
		}

		const location = upstream.headers.get('location');
		if (location !== null) {
			responseHeaders.set('location', rewriteStudioLocation(location, endpoint.host));
		}

		const withSetCookie = upstream.headers as Headers & { getSetCookie?: () => string[] };
		const cookies = withSetCookie.getSetCookie?.();
		if (cookies && cookies.length > 0) {
			for (const cookie of cookies) responseHeaders.append('set-cookie', cookie);
		} else {
			const cookie = upstream.headers.get('set-cookie');
			if (cookie !== null) responseHeaders.set('set-cookie', cookie);
		}

		// Streaming responses must not be buffered by the edge or transformed on the way through.
		if ((upstream.headers.get('content-type') ?? '').includes('text/event-stream')) {
			responseHeaders.set('x-accel-buffering', 'no');
			responseHeaders.set('cache-control', 'no-cache, no-transform');
		}

		const body = upstream.status === 204 || upstream.status === 304 ? null : upstream.body;
		return new Response(body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: responseHeaders
		});
	});

export const GET: RequestHandler = proxy;
export const HEAD: RequestHandler = proxy;
export const POST: RequestHandler = proxy;
export const PUT: RequestHandler = proxy;
export const PATCH: RequestHandler = proxy;
export const DELETE: RequestHandler = proxy;
export const OPTIONS: RequestHandler = proxy;

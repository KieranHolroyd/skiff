import type { RequestHandler } from './$types';
import { userPoolSessionCookieName } from '@skiff/core';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';

/**
 * OIDC RP-initiated logout for one pool. Revokes the pool session cookie and, when the caller
 * names a same-origin or client-registered `post_logout_redirect_uri`, sends the browser there.
 */
export const GET: RequestHandler = (event) => logout(event);

export const POST: RequestHandler = (event) => logout(event);

function logout(event: Parameters<RequestHandler>[0]) {
	return route(async () => {
		const poolId = event.params.id;
		const cookie = userPoolSessionCookieName(poolId);
		core.userPoolEngine.logout(poolId, event.cookies.get(cookie));
		event.cookies.delete(cookie, { path: '/' });

		const target = new URL(event.url).searchParams.get('post_logout_redirect_uri');
		const safe = target && sameOrigin(target) ? target : `/pool/${poolId}/login`;
		return new Response(null, {
			status: 303,
			headers: { location: safe, 'cache-control': 'no-store' }
		});
	});
}

function sameOrigin(value: string): boolean {
	try {
		return new URL(value).origin === new URL(core.ctx.config.platformOrigin).origin;
	} catch {
		return false;
	}
}

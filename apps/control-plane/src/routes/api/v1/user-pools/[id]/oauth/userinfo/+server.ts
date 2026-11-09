import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';

/** OIDC UserInfo for one pool. Authenticated by the pool's own bearer access token. */
export const GET: RequestHandler = (event) => userinfo(event.params.id, bearer(event.request));

export const POST: RequestHandler = (event) => userinfo(event.params.id, bearer(event.request));

function userinfo(poolId: string, token: string | null) {
	return route(async () => {
		if (!token) return json({ error: 'invalid_token', message: 'Send a Bearer access token.' }, 401);
		return json(await core.userPoolEngine.userinfo(poolId, token), 200, {
			'cache-control': 'no-store'
		});
	});
}

function bearer(request: Request): string | null {
	const header = request.headers.get('authorization');
	if (!header?.startsWith('Bearer ')) return null;
	return header.slice(7).trim() || null;
}

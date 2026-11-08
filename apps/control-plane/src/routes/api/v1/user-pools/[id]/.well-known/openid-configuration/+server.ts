import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';

/**
 * Public OIDC discovery for one pool (IAM.md §11.2). No authentication: an OIDC client needs the
 * document before any user exists. A disabled pool returns 404 rather than advertising dead
 * endpoints. Token, authorization and userinfo requests arrive with the identity engine (I27).
 */
export const GET: RequestHandler = (event) =>
	route(async () =>
		json(await core.userPools.discovery(event.params.id), 200, {
			'cache-control': 'public, max-age=300',
			'content-type': 'application/json; charset=utf-8'
		})
	);

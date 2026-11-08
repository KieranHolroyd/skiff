import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';

/**
 * The pool's public signing-key set. Each pool has its own `pool:<id>` purpose in the platform
 * ring, and the shared `/.well-known/jwks.json` deliberately excludes those (IAM.md §7.3).
 */
export const GET: RequestHandler = (event) =>
	route(async () =>
		json(await core.userPools.jwks(event.params.id), 200, {
			'cache-control': 'public, max-age=300',
			'content-type': 'application/json; charset=utf-8'
		})
	);

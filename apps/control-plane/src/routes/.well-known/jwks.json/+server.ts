import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';

/**
 * The platform's one public JWKS (docs/IAM.md §7.3, I15): every signing-key purpose except
 * `pool:*`, which publish their own keys under their own issuer in Part B.
 */
export const GET: RequestHandler = () =>
	Response.json(core.ctx.signingKeys.jwksAll(), {
		headers: {
			'cache-control': 'public, max-age=300',
			'content-type': 'application/json; charset=utf-8',
		},
	});

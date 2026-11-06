import { core } from '#lib/server/core.js';
import { renderNodeScript } from '#lib/server/install-node.js';
import type { RequestHandler } from './$types';

/** Public, cacheable installer script; the origin is baked in, the token/name stay arguments. */
export const GET: RequestHandler = () =>
	new Response(renderNodeScript(core.ctx.config.platformOrigin), {
		headers: {
			'content-type': 'text/x-shellscript; charset=utf-8',
			'cache-control': 'public, max-age=300',
			'x-content-type-options': 'nosniff',
		},
	});

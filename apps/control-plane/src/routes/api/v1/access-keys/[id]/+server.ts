import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Revoke one access key. Own keys need `accessKey:revoke`; anyone else's needs `revoke-any`. */

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.ctx.accessKeys.revoke(principal, event.params.id);
		return { ok: true };
	});

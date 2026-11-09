import type { RequestHandler } from './$types';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { sso } from '#lib/server/sso.js';

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		sso.removeGroupMapping(principal, event.params.id);
		return { ok: true };
	});

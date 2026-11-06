import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** End a silence now. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		core.alerts.expireSilence(requirePrincipal(event), event.params.id);
		return { ok: true };
	});

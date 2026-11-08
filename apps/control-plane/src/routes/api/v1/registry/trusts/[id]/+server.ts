import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

export const DELETE: RequestHandler = (event) =>
	route(() => {
		core.registry.deleteOidcTrust(requirePrincipal(event), event.params.id);
		return { deleted: true };
	});

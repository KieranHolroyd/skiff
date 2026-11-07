import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Take an address off the suppression list so it receives mail again. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		core.email.removeSuppression(requirePrincipal(event), event.params.address);
		return new Response(null, { status: 204 });
	});

import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One blueprint run by its operation id: status and the result of every resource step. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { run: core.blueprints.applyView(principal, event.params.id) };
	});

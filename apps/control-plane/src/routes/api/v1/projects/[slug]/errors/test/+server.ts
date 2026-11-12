import type { RequestHandler } from './$types.js';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Send one synthetic event through the real ingest storage path and return its ids. */
export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return json(core.appErrors.testEvent(principal, project), 201);
	});

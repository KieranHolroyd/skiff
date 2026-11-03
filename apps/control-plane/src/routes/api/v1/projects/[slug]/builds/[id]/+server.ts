import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** A single build with its full log. */
export const GET: RequestHandler = async (event) => {
	const principal = requirePrincipal(event);
	const project = core.projects.requireRow(principal, event.params.slug);
	return route(() => {
		if (event.request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
		return core.builds.get(principal, project, event.params.id);
	});
};

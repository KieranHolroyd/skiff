import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Cancel a queued or building job; the Builder's next report is rejected as already cancelled. */
export const POST: RequestHandler = async (event) => {
	const principal = requirePrincipal(event);
	const project = core.projects.requireRow(principal, event.params.slug);
	return route(() => {
		if (event.request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
		return core.builds.cancel(principal, project, event.params.id);
	});
};

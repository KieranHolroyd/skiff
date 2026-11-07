import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Cancel a queued run now, or ask the node to stop a running one (`cancelRequested` until it does). */
export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return { run: core.jobs.cancelRun(principal, project, event.params.id) };
	});

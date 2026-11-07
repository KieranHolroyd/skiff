import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Run the job now, whatever its schedule. 202 with the queued run; poll `location` for the result. */
export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const run = core.jobs.run(principal, project, event.params.name);
		return json({ run }, 202, { location: `/api/v1/projects/${encodeURIComponent(project.slug)}/jobs/runs/${run.id}` });
	});

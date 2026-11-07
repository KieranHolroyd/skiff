import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One run. `?wait=<seconds>` (up to 25) holds the request until the run finishes. */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const wait = Math.min(Math.max(Number(event.url.searchParams.get('wait') ?? 0) || 0, 0), 25);
		const run = wait > 0 ? await core.jobs.wait(principal, project, event.params.id, wait * 1000) : core.jobs.getRun(principal, project, event.params.id);
		return { run };
	});

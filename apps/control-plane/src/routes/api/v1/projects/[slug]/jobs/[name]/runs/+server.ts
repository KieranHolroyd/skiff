import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One job's runs, newest first (`?limit=`, up to 200; the newest 100 finished runs are kept). */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const limit = Number(event.url.searchParams.get('limit') ?? 50) || 50;
		return { runs: core.jobs.runs(principal, project, { job: event.params.name, limit }) };
	});

import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Config export (docs/OPERATIONS.md §13): a read-only snapshot of the caller's org configuration,
 * secrets by name only. `?project=<slug>` (repeatable or comma-separated) limits the projects.
 * Each section uses the caller's own permissions; what it cannot read is listed in `skipped`.
 */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const projects = event.url.searchParams
			.getAll('project')
			.flatMap((value) => value.split(','))
			.map((value) => value.trim())
			.filter(Boolean);
		return { export: await core.configExport.export(principal, { projects }) };
	});

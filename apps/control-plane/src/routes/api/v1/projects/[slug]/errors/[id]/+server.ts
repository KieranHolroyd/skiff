import type { RequestHandler } from './$types.js';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return core.appErrors.get(principal, project, event.params.id);
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return json({ deleted: core.appErrors.deleteIssue(principal, project, event.params.id) });
	});

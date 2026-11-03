import type { RequestHandler } from './$types';
import { environmentCreateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Named environments for a project (D13, v2). Production is always present. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return { environments: core.environments.list(principal, project) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, environmentCreateSchema);
		return json(core.environments.create(principal, project, input), 201);
	});

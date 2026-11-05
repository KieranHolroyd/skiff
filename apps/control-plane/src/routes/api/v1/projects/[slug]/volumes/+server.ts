import type { RequestHandler } from './$types';
import { appVolumeCreateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Project-owned app volumes (plan 07). Mount paths are sandbox paths; no host path is exposed. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return { volumes: core.appVolumes.list(principal, project) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, appVolumeCreateSchema);
		return json(core.appVolumes.create(principal, project, input), 201);
	});

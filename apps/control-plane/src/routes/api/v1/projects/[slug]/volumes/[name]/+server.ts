import type { RequestHandler } from './$types';
import { appVolumeUpdateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return { volume: core.appVolumes.get(principal, project, event.params.name) };
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, appVolumeUpdateSchema);
		return { volume: core.appVolumes.update(principal, project, event.params.name, input) };
	});

/** Soft delete. Refused while attached; the data is retained for seven days. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return core.appVolumes.delete(principal, project, event.params.name);
	});

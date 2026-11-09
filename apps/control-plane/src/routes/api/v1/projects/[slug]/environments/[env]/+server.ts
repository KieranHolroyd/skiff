import type { RequestHandler } from './$types';
import { environmentUpdateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Rename/tune an environment, or delete it once its deployments are gone. */

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, environmentUpdateSchema);
		return core.environments.update(principal, project, event.params.env, input);
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		core.environments.remove(principal, project, event.params.env);
		return { ok: true };
	});

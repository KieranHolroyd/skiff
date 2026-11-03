import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const bodySchema = z.object({
	deploymentId: z.string().min(1).max(64).describe('Deployment id or short id'),
});

/** Move this environment's pointer without touching production (unless env is production). */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, bodySchema);
		return core.environments.promote(principal, project, event.params.env, input.deploymentId);
	});

import type { RequestHandler } from './$types';
import { composeDeploySchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Deploy a docker-compose file to a level-4 project (docs/COMPOSE.md). The file is parsed and
 * validated before anything is stored; unsupported features fail the deploy rather than running a
 * partial stack. The result is a normal deployment, so promote/rollback work unchanged.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, composeDeploySchema);
		const deployment = await core.deployments.deployCompose(principal, project, input);
		return json({ deployment, workload: core.workloads.get(principal, project) }, 201);
	});

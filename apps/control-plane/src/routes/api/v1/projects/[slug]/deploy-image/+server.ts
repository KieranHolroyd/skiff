import type { RequestHandler } from './$types';
import { imageDeploySchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Set a container project's image and deploy it in one call (docs/REGISTRY.md §5.3). The deploy
 * pins the tag to its digest (R1); the rest of the workload spec is kept.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, imageDeploySchema);
		const deployment = await core.deployments.deployImage(principal, project, input);
		return json({ deployment, workload: core.workloads.get(principal, project) }, 201);
	});

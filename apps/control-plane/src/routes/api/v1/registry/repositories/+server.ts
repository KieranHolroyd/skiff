import type { RequestHandler } from './$types';
import { registryAutoDeploySchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The org's repositories in the platform registry (created on first push). */
export const GET: RequestHandler = (event) =>
	route(() => ({ repositories: core.registry.listRepositories(requirePrincipal(event)) }));

/**
 * Deploy on push (docs/REGISTRY.md §5.3): `{ repository, project, tag? }` makes every push of `tag`
 * (default `latest`) deploy to the container project; `project: null` turns it off.
 */
export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, registryAutoDeploySchema);
		return { repository: core.registry.setAutoDeploy(principal, input.repository, { project: input.project, tag: input.tag }) };
	});

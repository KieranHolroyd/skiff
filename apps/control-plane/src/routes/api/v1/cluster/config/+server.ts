import type { RequestHandler } from './$types';
import { clusterConfigUpdateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Cluster tunables (D107). Platform admins read; a platform admin's own session changes them. */
export const GET: RequestHandler = (event) =>
	route(() => ({ config: core.cluster.view(requirePrincipal(event)) }));

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, clusterConfigUpdateSchema);
		return { config: core.cluster.update(principal, input) };
	});

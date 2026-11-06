import type { RequestHandler } from './$types';
import { clusterConfigUpdateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

export const GET: RequestHandler = (event) =>
	route(() => {
		requirePrincipal(event);
		return { config: core.cluster.get() };
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, clusterConfigUpdateSchema);
		return { config: core.cluster.update(principal, input) };
	});

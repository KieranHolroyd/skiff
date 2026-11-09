import type { RequestHandler } from './$types';
import { dashboardUpdateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

export const GET: RequestHandler = (event) =>
	route(() => ({ dashboard: core.observability.get(requirePrincipal(event), event.params.id) }));

/** Saves need the `version` they were based on; a stale one is a 409. */
export const PUT: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, dashboardUpdateSchema);
		return { dashboard: core.observability.update(principal, event.params.id, input) };
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		core.observability.delete(requirePrincipal(event), event.params.id);
		return { ok: true };
	});

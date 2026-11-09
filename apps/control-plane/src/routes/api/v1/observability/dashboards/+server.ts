import type { RequestHandler } from './$types';
import { dashboardCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Saved observability dashboards for the caller's org (D101). */
export const GET: RequestHandler = (event) =>
	route(() => ({ dashboards: core.observability.list(requirePrincipal(event)) }));

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, dashboardCreateSchema);
		return json({ dashboard: core.observability.create(principal, input) }, 201);
	});

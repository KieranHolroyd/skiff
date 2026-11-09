import { serverErrorUpdateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import type { RequestHandler } from './$types';

/** One server error issue with its newest events and counts (docs/SERVER-ERRORS.md). */
export const GET: RequestHandler = (event) =>
	route(() => core.serverErrors.get(requirePrincipal(event), event.params.id));

/** `{ status: "resolved" | "ignored" | "unresolved" }` */
export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const body = await readJson(event.request, serverErrorUpdateSchema);
		core.serverErrors.setStatus(principal, [event.params.id], body.status);
		return core.serverErrors.get(principal, event.params.id).issue;
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const deleted = core.serverErrors.delete(principal, [event.params.id]);
		return { deleted: deleted > 0 };
	});

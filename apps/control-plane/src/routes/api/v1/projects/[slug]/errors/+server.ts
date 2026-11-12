import type { RequestHandler } from './$types.js';
import { appErrorListQuerySchema, appErrorStatusUpdateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** A project's app errors (docs/APP-ERRORS.md). */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const query = Object.fromEntries(event.url.searchParams);
		return core.appErrors.list(principal, project, appErrorListQuerySchema.parse(query));
	});

/** `{ ids: [...], status: 'unresolved'|'resolved'|'ignored' }` */
export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, appErrorStatusUpdateSchema);
		return json({ updated: core.appErrors.setStatus(principal, project, input) });
	});

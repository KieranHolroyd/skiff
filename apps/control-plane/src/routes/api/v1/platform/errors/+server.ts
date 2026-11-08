import * as z from 'zod';
import { serverErrorListQuerySchema, serverErrorStatuses } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import type { RequestHandler } from './$types';

/**
 * Server errors (docs/SERVER-ERRORS.md): the control plane's grouped exceptions and 5xx answers.
 * `GET ?status=unresolved|resolved|ignored|all&source=&q=&before=&limit=` lists issues, newest
 * first; `PATCH { ids, status }` resolves, ignores or reopens several at once. Platform admins only.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const query = serverErrorListQuerySchema.parse(Object.fromEntries(event.url.searchParams));
		return core.serverErrors.list(principal, query);
	});

const bulkSchema = z.object({
	ids: z.array(z.string().min(1).max(64)).min(1).max(500),
	status: z.enum(serverErrorStatuses)
});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const body = await readJson(event.request, bulkSchema);
		return { updated: core.serverErrors.setStatus(principal, body.ids, body.status) };
	});

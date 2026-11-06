import type { RequestHandler } from './$types';
import { observabilityQueryRequestSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Run one panel query (D101). POST because a query carries a spec or SQL body; it changes
 * nothing. Aborting the request (a panel re-renders) cancels the ClickHouse query.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, observabilityQueryRequestSchema);
		return core.observability.query(principal, input, event.request.signal);
	});

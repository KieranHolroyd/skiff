import type { RequestHandler } from './$types';
import { userPoolClientCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * OIDC clients for one pool. The secret is returned exactly once, from POST; every list only
 * carries the public `client_id` and redirect allowlist.
 */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { clients: core.userPools.listClients(principal, event.params.id) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, userPoolClientCreateSchema);
		return json(core.userPools.createClient(principal, event.params.id, input), 201);
	});

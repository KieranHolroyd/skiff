import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The failover controller: lease, policy, lost nodes, ingress rotation, database candidates, history. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return core.failover.status(principal);
	});

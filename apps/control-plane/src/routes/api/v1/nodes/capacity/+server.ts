import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Per-node workload-slice budget and reservation (platform admin view, D41). */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { capacity: core.workloads.capacity(principal) };
	});

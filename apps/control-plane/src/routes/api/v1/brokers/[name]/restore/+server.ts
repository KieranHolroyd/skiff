import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Bring a soft-deleted broker back (admission is re-checked; the data dir is intact). */
export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { broker: core.brokers.restore(principal, event.params.name) };
	});

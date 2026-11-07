import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Queue one synthetic event through the rule, to check the consuming function end to end. */
export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json({ delivery: core.events.test(principal, event.params.id) }, 202);
	});

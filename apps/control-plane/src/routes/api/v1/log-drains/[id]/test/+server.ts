import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Send one test line now; the answer says whether the receiver accepted it. Counters are left alone. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return { result: await core.logDrains.test(principal, event.params.id) };
	});

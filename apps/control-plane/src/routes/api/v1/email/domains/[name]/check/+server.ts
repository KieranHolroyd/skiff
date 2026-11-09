import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Look the domain's records up in public DNS now (re-publishing them first when Yoal manages the zone). */
export const POST: RequestHandler = (event) =>
	route(async () => ({
		domain: await core.email.checkDomain(requirePrincipal(event), event.params.name)
	}));

import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Send a test notification through the rule's channels; returns the per-channel outcome. */
export const POST: RequestHandler = (event) =>
	route(async () => ({ delivery: await core.alerts.test(requirePrincipal(event), event.params.id) }));

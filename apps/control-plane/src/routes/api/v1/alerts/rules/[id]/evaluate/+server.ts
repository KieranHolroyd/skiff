import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Evaluate the rule now (state changes and notifications apply, as on its schedule). */
export const POST: RequestHandler = (event) =>
	route(async () => ({ rule: await core.alerts.evaluateRule(requirePrincipal(event), event.params.id) }));

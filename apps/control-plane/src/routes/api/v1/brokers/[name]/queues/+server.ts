import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The newest JetStream stream listing the broker's node reported (D123). */
export const GET: RequestHandler = (event) =>
	route(() => core.brokers.queues(requirePrincipal(event), event.params.name));

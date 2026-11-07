import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Start removing a replica: its node deletes the data dir and the primary drops its slot; the
 * row disappears once both are confirmed (202 with the replica marked `removing`).
 */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json({ replica: core.databaseReplicas.remove(principal, event.params.name, event.params.id) }, 202);
	});

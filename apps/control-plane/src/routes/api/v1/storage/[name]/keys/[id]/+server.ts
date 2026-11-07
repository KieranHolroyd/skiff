import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Revoke a named key; the node removes its RustFS user on the next round. Idempotent. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { key: core.storage.revokeKey(principal, event.params.name, event.params.id) };
	});

import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Revoke a connected app: its consent and tokens go, and its next call to `/mcp` must re-authorize.
 * Someone else's grant needs `member:remove`; an owner's needs an owner.
 */
export const DELETE: RequestHandler = (event) =>
	route(() => core.connectedApps.revoke(requirePrincipal(event), event.params.id));

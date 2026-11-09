import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Revoke a named machine token. The row is kept for history; the policy version is bumped so
 * browsers signed in under it are signed out as well.
 */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.accessPolicies.revokeServiceToken(principal, event.params.id, event.params.tokenId);
		return json({ ok: true });
	});

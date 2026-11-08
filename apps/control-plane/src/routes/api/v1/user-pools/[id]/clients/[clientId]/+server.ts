import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Remove one client. `clientId` may be the row id or the public OIDC `client_id`. */

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.userPools.deleteClient(principal, event.params.id, event.params.clientId);
		return { ok: true };
	});

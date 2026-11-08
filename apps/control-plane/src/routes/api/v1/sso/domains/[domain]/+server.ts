import type { RequestHandler } from './$types';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { sso } from '#lib/server/sso.js';

/** Remove a domain claim. Sign-in routing stops immediately. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		sso.removeDomain(principal, event.params.domain);
		return { ok: true };
	});

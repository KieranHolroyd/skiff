import type { RequestHandler } from './$types';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { sso } from '#lib/server/sso.js';

/** Re-read the TXT record now instead of waiting for the daily check. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return sso.verifyDomain(principal, event.params.domain);
	});

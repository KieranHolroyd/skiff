import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Remove a sandbox recipient; while the org is in the sandbox, sends to it are refused again. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		core.email.removeSandboxAddress(requirePrincipal(event), event.params.address);
		return new Response(null, { status: 204 });
	});

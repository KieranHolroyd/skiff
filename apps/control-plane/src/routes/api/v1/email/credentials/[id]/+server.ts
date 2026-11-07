import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Revoke a credential; the mail node stops accepting it at its next state pull. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		core.email.revokeCredential(requirePrincipal(event), event.params.id);
		return new Response(null, { status: 204 });
	});

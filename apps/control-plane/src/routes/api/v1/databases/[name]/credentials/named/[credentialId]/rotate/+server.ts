import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Rotate a named credential's password. Staged like the owner rotation (D86): the node applies
 * `ALTER ROLE` first, then the live secret swaps and apps attached with it restart.
 */
export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json(
			{ credential: core.databases.rotateNamedCredential(principal, event.params.name, event.params.credentialId) },
			202,
		);
	});

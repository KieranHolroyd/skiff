import type { RequestHandler } from './$types';
import { databaseCredentialCreateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Named credentials (docs/DATABASES.md §16): the built-in owner and monitor rows plus opt-in
 * `app`, `readonly` and `backup` roles. Listing never includes a password.
 */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { credentials: core.databases.listCredentials(principal, event.params.name) };
	});

/** Create a credential; the node provisions the role, so it starts `pending`. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, databaseCredentialCreateSchema);
		return json({ credential: core.databases.createCredential(principal, event.params.name, input) }, 202);
	});

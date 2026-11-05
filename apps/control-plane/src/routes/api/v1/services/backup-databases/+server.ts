import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Queue a backup for every live database that is not already backing up. */
export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json(core.serviceActions.backupAllDatabases(principal), 202);
	});

import type { RequestHandler } from './$types';
import { databaseRestoreSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Restore an artifact into a brand-new database (never in place by default). */

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, databaseRestoreSchema);
		return json(
			{ database: core.databases.restoreBackup(principal, event.params.name, event.params.backupId, input) },
			202,
		);
	});

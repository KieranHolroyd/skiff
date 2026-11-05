import type { RequestHandler } from './$types';
import { databasePitrRestoreSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Restore to a timestamp into a new database (docs/PITR.md). In-place is not supported. */

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, databasePitrRestoreSchema);
		return json(
			{ database: core.databases.restoreToTimestamp(principal, event.params.name, input) },
			202,
		);
	});

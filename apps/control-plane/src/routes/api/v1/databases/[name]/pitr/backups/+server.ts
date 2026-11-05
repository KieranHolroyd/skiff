import type { RequestHandler } from './$types';
import { databasePitrBackupSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Queue a manual pgBackRest base backup (docs/PITR.md). */

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, databasePitrBackupSchema);
		return json({ task: core.databases.pitrBackup(principal, event.params.name, input) }, 202);
	});

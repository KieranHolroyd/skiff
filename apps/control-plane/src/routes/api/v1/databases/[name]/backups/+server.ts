import type { RequestHandler } from './$types';
import { databaseBackupCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** List and queue logical backups for one database (docs/DATABASES.md §9). */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { backups: core.databases.listBackups(principal, event.params.name) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, databaseBackupCreateSchema);
		return json({ backup: core.databases.createBackup(principal, event.params.name, input) }, 202);
	});

import type { RequestHandler } from './$types';
import { databaseBackupPolicySchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Backup schedule and retention for one database. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { backup: core.databases.backupPolicy(principal, event.params.name) };
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, databaseBackupPolicySchema);
		return { backup: core.databases.setBackupPolicy(principal, event.params.name, input) };
	});

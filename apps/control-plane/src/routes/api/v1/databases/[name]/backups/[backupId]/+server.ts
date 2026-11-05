import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One backup artifact. Deleting it removes the object before the metadata row. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { backup: core.databases.getBackup(principal, event.params.name, event.params.backupId) };
	});

export const DELETE: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		await core.databases.deleteBackup(principal, event.params.name, event.params.backupId);
		return { ok: true };
	});

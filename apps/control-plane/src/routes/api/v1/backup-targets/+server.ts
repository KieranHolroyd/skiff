import type { RequestHandler } from './$types';
import { backupTargetCreateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Backup targets (plan 05, docs/BACKUPS.md). Checks live in `core.backupTargets`. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { targets: core.backupTargets.list(principal) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, backupTargetCreateSchema);
		const platform = event.url.searchParams.get('platform') === '1';
		const result = core.backupTargets.create(principal, input, { platform });
		return json(result, 201);
	});

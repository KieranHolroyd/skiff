import type { RequestHandler } from './$types';
import { configImportRequestSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Config import, plan (docs/OPERATIONS.md §14): what an apply would create, what already exists
 * and what must be done by hand. Reads only; nothing is changed.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, configImportRequestSchema);
		return { import: await core.configImport.plan(principal, input) };
	});

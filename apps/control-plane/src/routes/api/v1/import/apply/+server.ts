import type { RequestHandler } from './$types';
import { configImportRequestSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Config import, apply (docs/OPERATIONS.md §14). Create-only: a resource that already exists under
 * the same name is left as it is. Every step runs through the normal service with the caller's
 * permissions; a failed step skips the steps that depend on it and the rest carry on. Audited as
 * `config.import`.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, configImportRequestSchema);
		return { import: await core.configImport.apply(principal, input) };
	});

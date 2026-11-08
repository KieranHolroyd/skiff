import type { RequestHandler } from './$types';
import { githubImportSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Deploy from Git (docs/FORGES.md §7): create the project, its git source (and the forge webhook),
 * the first build and, when the repository has workflows, its pipeline repository.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, githubImportSchema);
		return json(await core.githubImport.importRepository(principal, input), 201);
	});

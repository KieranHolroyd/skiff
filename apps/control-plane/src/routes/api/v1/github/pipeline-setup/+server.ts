import type { RequestHandler } from './$types';
import { pipelineAutoSetupSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Automatic pipeline setup through the GitHub App (docs/GITHUB.md §10): whether a push to an
 * App-covered repository with `.skiff/workflows` adds it to Pipelines, and which removed
 * repositories stay removed.
 */
export const GET: RequestHandler = (event) =>
	route(() => core.pipelines.autoSetup(requirePrincipal(event)));

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return core.pipelines.setAutoSetup(
			principal,
			await readJson(event.request, pipelineAutoSetupSchema)
		);
	});

import type { RequestHandler } from './$types';
import { blueprintPlanRequestSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Diff a blueprint (YAML or JSON text, or a parsed object) against live state. Changes nothing:
 * the plan is stored as a planned operation for an hour and applied by its `planHash`. Any
 * problem (a missing permission or secret, an immutable field, a taken name) is a 422 listing
 * every issue with its resource path.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, blueprintPlanRequestSchema);
		return { plan: await core.blueprints.plan(principal, input) };
	});

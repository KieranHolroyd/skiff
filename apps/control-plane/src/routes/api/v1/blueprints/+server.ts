import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Blueprint stacks (plan 11, docs/OPERATIONS.md §12): what each applied stack manages and how its
 * last apply went. Plan with `POST /blueprints/plan`, apply with `POST /blueprints/apply`. Every
 * check lives in `core.blueprints`; the feature needs `SKIFF_FEATURE_BLUEPRINTS`.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { stacks: core.blueprints.list(principal) };
	});

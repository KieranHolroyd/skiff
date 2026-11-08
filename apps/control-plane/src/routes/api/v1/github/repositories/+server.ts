import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Repositories the org's GitHub App installations can reach (docs/GITHUB.md), for pickers in the
 * dashboard, the CLI and agents. `?refresh=1` skips the two-minute cache.
 */
export const GET: RequestHandler = (event) =>
	route(() =>
		core.githubApp.repositories(requirePrincipal(event), {
			refresh: event.url.searchParams.get('refresh') === '1'
		})
	);

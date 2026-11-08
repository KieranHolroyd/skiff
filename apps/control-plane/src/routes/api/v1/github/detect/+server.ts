import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Deploy from GitHub, step one (docs/GITHUB.md §9): read `?repository=owner/name[&branch][&rootDir]`
 * through the org's GitHub App and suggest how to build it.
 */
export const GET: RequestHandler = (event) =>
	route(() =>
		core.githubImport.detect(requirePrincipal(event), {
			repository: event.url.searchParams.get('repository') ?? '',
			branch: event.url.searchParams.get('branch') || undefined,
			rootDir: event.url.searchParams.get('rootDir') || undefined
		})
	);

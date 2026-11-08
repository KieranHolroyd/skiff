import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Deploy from Git, step one (docs/FORGES.md §7): read
 * `?repository=<full name>[&connectionId][&branch][&rootDir]` through the GitHub App (no
 * `connectionId`) or a forge connection, and suggest how to build it.
 */
export const GET: RequestHandler = (event) =>
	route(() =>
		core.githubImport.detect(requirePrincipal(event), {
			repository: event.url.searchParams.get('repository') ?? '',
			connectionId: event.url.searchParams.get('connectionId') || undefined,
			branch: event.url.searchParams.get('branch') || undefined,
			rootDir: event.url.searchParams.get('rootDir') || undefined
		})
	);

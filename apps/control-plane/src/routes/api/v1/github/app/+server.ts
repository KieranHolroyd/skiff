import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Whether Skiff's GitHub App is connected, and where to install it (docs/GITHUB.md). */
export const GET: RequestHandler = (event) => {
	const principal = requirePrincipal(event);
	return route(() => ({ app: core.githubApp.view(principal), installUrl: core.githubApp.installUrl(principal) }));
};

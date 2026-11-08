import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The org's GitHub App installations (plus unclaimed ones for platform admins). */
export const GET: RequestHandler = (event) =>
	route(() => ({ installations: core.githubApp.installations(requirePrincipal(event)) }));

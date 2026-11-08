import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Repositories from every provider the org connects (docs/FORGES.md §2): the GitHub App's
 * installations and each GitLab, Gitea or Forgejo connection. `?refresh=1` skips the caches.
 */
export const GET: RequestHandler = (event) =>
	route(() => core.git.repositories(requirePrincipal(event), { refresh: event.url.searchParams.get('refresh') === '1' }));

import type { RequestHandler } from './$types';
import { forgeWebhookCreateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Create (or re-create) a hook on the forge (docs/FORGES.md §3): `{ repository }` for one
 * repository, `{ namespace }` for a GitLab group or Gitea/Forgejo organisation. A failure is
 * returned on the hook (`error`), not thrown.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, forgeWebhookCreateSchema);
		return json(await core.forges.addWebhook(principal, event.params.id, input), 201);
	});

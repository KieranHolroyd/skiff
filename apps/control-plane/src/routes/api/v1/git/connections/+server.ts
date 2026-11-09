import type { RequestHandler } from './$types';
import { forgeConnectionCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * GitLab, Gitea and Forgejo connections of the org (docs/FORGES.md §2). Tokens are write-only;
 * creating one proves it with the forge first. Owners and admins only.
 */
export const GET: RequestHandler = (event) => route(() => ({ connections: core.forges.list(requirePrincipal(event)) }));

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, forgeConnectionCreateSchema);
		return json(await core.forges.create(principal, input), 201);
	});

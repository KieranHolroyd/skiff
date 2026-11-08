import type { RequestHandler } from './$types';
import { forgeConnectionUpdateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One git provider connection (docs/FORGES.md §2): read, rename or replace tokens, remove. */
export const GET: RequestHandler = (event) => route(() => core.forges.get(requirePrincipal(event), event.params.id));

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, forgeConnectionUpdateSchema);
		return core.forges.update(principal, event.params.id, input);
	});

/** Removes the connection and the hooks Skiff created on the forge (best effort). */
export const DELETE: RequestHandler = (event) =>
	route(async () => {
		await core.forges.remove(requirePrincipal(event), event.params.id);
		return json({ ok: true });
	});

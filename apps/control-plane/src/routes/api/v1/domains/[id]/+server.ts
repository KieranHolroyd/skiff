import { json, route } from '#lib/server/api.js';
import { core } from '#lib/server/core.js';
import { requirePrincipal } from '#lib/server/principal.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
	route(() => core.domains.get(requirePrincipal(event), event.params.id));

export const DELETE: RequestHandler = (event) =>
	route(async () => {
		await core.domains.remove(requirePrincipal(event), event.params.id);
		return json({ ok: true });
	});

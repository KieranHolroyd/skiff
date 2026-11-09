import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Delete a hook Yoal created (on the forge too, best effort). */
export const DELETE: RequestHandler = (event) =>
	route(async () => {
		await core.forges.removeWebhook(requirePrincipal(event), event.params.id, event.params.webhook);
		return json({ ok: true });
	});

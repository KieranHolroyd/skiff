import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** End one share-link session (`red_…`); agents refuse its cookie once they pull the revocation. */
export const DELETE: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		await core.access.revokeSession(principal, project, event.params.id);
		return { ok: true, sessionId: event.params.id };
	});

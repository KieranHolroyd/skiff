import type { RequestHandler } from './$types';
import { serviceRestartSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Restart every managed service, one kind, or an explicit list. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, serviceRestartSchema);
		return json(core.serviceActions.restart(principal, input), 202);
	});

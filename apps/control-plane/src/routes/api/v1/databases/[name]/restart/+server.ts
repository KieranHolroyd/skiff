import type { RequestHandler } from './$types';
import { databaseRestartSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Restart the database (and its pooler) or only the pooler sidecar. */

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, databaseRestartSchema);
		return json(
			{
				database: core.databases.restart(principal, event.params.name, input),
				target: input.target
			},
			202,
		);
	});

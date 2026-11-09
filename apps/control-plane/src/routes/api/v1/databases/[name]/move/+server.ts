import type { RequestHandler } from './$types';
import { serviceMoveSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The newest move of this database (D97), or `{ move: null }`. */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return { move: core.moves.latestForDatabase(principal, event.params.name) };
	});

/** Start moving the database to another node: stop apps → final dump → restore → purge old copy. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, serviceMoveSchema);
		return json({ move: core.moves.moveDatabase(principal, event.params.name, input) }, 202);
	});

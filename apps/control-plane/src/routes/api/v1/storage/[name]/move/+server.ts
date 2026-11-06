import type { RequestHandler } from './$types';
import { serviceMoveSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Move the storage instance to another node (D97). Objects are not copied, so the body must say
 * `from: "empty"`; buckets, keys and attachments come back on the target.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, serviceMoveSchema);
		return json(core.moves.moveStorage(principal, event.params.name, input), 202);
	});

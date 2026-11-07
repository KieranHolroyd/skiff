import type { RequestHandler } from './$types';
import { logDrainCreateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Log drains (DESIGN §8 "Logs"). Every check lives in `core.logDrains`. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { drains: core.logDrains.list(principal), canEdit: core.logDrains.canEdit(principal) };
	});

/** A webhook drain's signing secret is in the answer once (`signingSecret`); it can't be read again. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, logDrainCreateSchema);
		return json(core.logDrains.create(principal, input), 201);
	});

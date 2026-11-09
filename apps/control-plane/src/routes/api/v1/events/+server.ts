import type { RequestHandler } from './$types';
import { eventRuleCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Event notification rules (docs/EVENTS.md, D122). Every check lives in `core.events`. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { rules: core.events.list(principal) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, eventRuleCreateSchema);
		return json({ rule: core.events.create(principal, input) }, 201);
	});

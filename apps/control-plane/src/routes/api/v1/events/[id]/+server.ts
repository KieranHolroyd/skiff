import type { RequestHandler } from './$types';
import { eventRuleUpdateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One event rule. Deleting it drops its undelivered events; delivered history stays 7 days. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { rule: core.events.get(principal, event.params.id) };
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, eventRuleUpdateSchema);
		return { rule: core.events.update(principal, event.params.id, input) };
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.events.delete(principal, event.params.id);
		return { ok: true };
	});

import type { RequestHandler } from './$types';
import { alertRuleUpdateSchema, type AlertRuleUpdateInput } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One rule with its series. */
export const GET: RequestHandler = (event) =>
	route(() => ({ rule: core.alerts.getRule(requirePrincipal(event), event.params.id) }));

/** Partial update; `version` is required and a stale one is a 409. */
export const PUT: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = (await readJson(event.request, alertRuleUpdateSchema)) as AlertRuleUpdateInput;
		return { rule: core.alerts.updateRule(principal, event.params.id, input) };
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		core.alerts.deleteRule(requirePrincipal(event), event.params.id);
		return { ok: true };
	});

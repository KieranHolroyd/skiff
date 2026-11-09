import type { RequestHandler } from './$types';
import { alertRuleCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Metric alert rules for the caller's org (docs/ALERTS.md). */
export const GET: RequestHandler = (event) =>
	route(() => ({ rules: core.alerts.listRules(requirePrincipal(event)) }));

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, alertRuleCreateSchema);
		return json({ rule: core.alerts.createRule(principal, input) }, 201);
	});

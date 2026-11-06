import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const ackSchema = z.object({
	fingerprint: z.string().min(1).max(10_000),
	acknowledged: z.boolean().default(true)
});

/** Acknowledge a firing series (stops repeat notifications until it resolves), or undo that. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, ackSchema);
		return {
			rule: core.alerts.acknowledge(principal, event.params.id, input.fingerprint, input.acknowledged)
		};
	});

import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const previewSchema = z.object({
	/** An unsaved rule (validated by the service), or omit to preview the saved `ruleId`. */
	rule: z.unknown().optional(),
	ruleId: z.string().max(64).optional()
});

/** Evaluate a rule once over its window without saving state or notifying. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, previewSchema);
		return core.alerts.preview(principal, input);
	});

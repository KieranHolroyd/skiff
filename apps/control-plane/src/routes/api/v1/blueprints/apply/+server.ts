import type { RequestHandler } from './$types';
import { blueprintApplyRequestSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Apply your own plan by its hash, within the hour. Live state is re-read first and a plan whose
 * world moved is a 409; a pruning plan needs `confirm` set to the stack name. Returns 202 with the
 * run: follow it on `/operations/:id/stream`, or pass `?wait=<seconds>` (≤25) to hold the response
 * until it settles. Submitting the same hash again returns the same run.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, blueprintApplyRequestSchema);
		const waitMs =
			Math.min(Math.max(Number(event.url.searchParams.get('wait') ?? 0) || 0, 0), 25) * 1000;
		const run = waitMs
			? await core.blueprints.applyAndWait(principal, input, waitMs)
			: core.blueprints.apply(principal, input);
		return json({ run }, 202);
	});

import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One applied stack: its managed resource keys, last applied document and last run. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const stack = core.blueprints.get(principal, event.params.name);
		let lastRun = null;
		if (stack.lastOperationId) {
			try {
				lastRun = core.blueprints.applyView(principal, stack.lastOperationId);
			} catch {
				// Old runs are removed after the operation retention window.
			}
		}
		return { stack, lastRun };
	});

import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Close a campaign and apply its decisions (IAM.md §9.5). */
export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return core.governance.completeReview(principal, event.params.id!);
	});

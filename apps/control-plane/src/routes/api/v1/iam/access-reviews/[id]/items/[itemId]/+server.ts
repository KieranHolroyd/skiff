import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const decide = z.object({ decision: z.enum(['keep', 'revoke', 'shorten']) });

/**
 * Record a review item's decision (IAM.md §9.5). The item id is the unit of work; the `id` in the
 * path names the campaign, and the service verifies the item belongs to the org and is still open.
 */
export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, decide);
		return core.governance.decideReviewItem(principal, event.params.itemId!, input.decision);
	});

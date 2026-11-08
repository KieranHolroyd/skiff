import type { RequestHandler } from './$types';
import * as z from 'zod';
import type { ScopeRef } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const scope = z.object({
	type: z.string().min(1),
	id: z.string().min(1).optional(),
	projectId: z.string().min(1).optional()
});

const status = z.enum(['open', 'completed']);

const createReview = z.object({
	scope,
	name: z.string().min(2).max(80).optional(),
	defaultDecision: z.enum(['keep', 'revoke']).optional(),
	dueAt: z.number().int().positive().optional()
});

/**
 * Access reviews (IAM.md I23, §9.5). A campaign snapshots the bindings at a scope; items are
 * decided with keep/revoke/shorten and completion applies them. `GET` needs `iam:read`; every
 * write needs `iam:review` at the campaign's scope.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const raw = event.url.searchParams.get('status');
		const parsed = raw ? status.safeParse(raw) : undefined;
		return {
			reviews: core.governance.listReviews(principal, {
				status: parsed?.success ? parsed.data : undefined
			}),
			can: {
				review: core.iam.can(principal, 'iam:review', { type: 'org' })
			}
		};
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, createReview);
		return json(
			core.governance.startReview(principal, {
				...input,
				scope: input.scope as ScopeRef
			}),
			201
		);
	});

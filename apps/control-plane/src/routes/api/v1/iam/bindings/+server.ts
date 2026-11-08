import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const scope = z.object({
	type: z.string().min(1),
	id: z.string().min(1).optional(),
	projectId: z.string().min(1).optional(),
});

const createBinding = z.object({
	principalType: z.enum(['user', 'group', 'serviceAccount']),
	principalId: z.string().min(1),
	roleId: z.string().min(1),
	scope,
	condition: z.object({ op: z.string().min(1) }).passthrough().optional(),
	expiresAt: z.number().int().positive().optional(),
	reason: z.string().max(500).optional(),
});

/** Bind a principal to a role at a scope (IAM.md §7). */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, createBinding);
		return json(
			core.iam.bind(principal, {
				...input,
				scope: input.scope as Parameters<typeof core.iam.bind>[1]['scope'],
				condition: input.condition as Parameters<typeof core.iam.bind>[1]['condition'],
			}),
			201,
		);
	});

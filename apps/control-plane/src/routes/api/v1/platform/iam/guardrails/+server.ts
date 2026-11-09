import type { RequestHandler } from './$types';
import * as z from 'zod';
import type { Condition, ScopeRef } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const scope = z.object({
	type: z.string().min(1),
	id: z.string().min(1).optional(),
	projectId: z.string().min(1).optional(),
});

const selector = z
	.object({
		principalTypes: z.array(z.string().min(1)).max(16).optional(),
		principalIds: z.array(z.string().min(1)).max(256).optional(),
		groupIds: z.array(z.string().min(1)).max(256).optional(),
	})
	.strict();

const condition = z.object({ op: z.string().min(1) }).passthrough();

const createGuardrail = z.object({
	name: z.string().min(2).max(80).optional(),
	permissions: z.array(z.string().min(1).max(120)).min(1).max(500).optional(),
	selector: selector.optional(),
	scope: scope.optional(),
	condition: condition.nullish(),
	enabled: z.boolean().optional(),
});

/**
 * Platform guardrails (IAM.md I11, §10): deny rows with `org_id IS NULL` that the engine applies
 * to every org. Reads need a platform read; every write needs a platform admin who also holds
 * `iam:manage-guardrails`.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return {
			guardrails: core.platformIam.listGuardrails(principal),
			can: {
				manage:
					core.platformIam.canAdminister(principal) &&
					core.iam.can(principal, 'iam:manage-guardrails', { type: 'org' }),
			},
		};
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, createGuardrail);
		return json(
			core.platformIam.createGuardrail(principal, {
				...input,
				scope: input.scope as ScopeRef | undefined,
				condition: input.condition as Condition | null | undefined,
			}),
			201,
		);
	});

import type { RequestHandler } from './$types';
import * as z from 'zod';
import type { Condition, ScopeRef } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
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

const updateGuardrail = z.object({
	name: z.string().min(2).max(80).optional(),
	permissions: z.array(z.string().min(1).max(120)).min(1).max(500).optional(),
	selector: selector.optional(),
	scope: scope.optional(),
	condition: condition.nullish(),
	enabled: z.boolean().optional(),
});

/** Edit or delete one fleet-wide guardrail (IAM.md I11, §10). */
export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, updateGuardrail);
		return core.platformIam.updateGuardrail(principal, event.params.id!, {
			...input,
			scope: input.scope as ScopeRef | undefined,
			condition: input.condition as Condition | null | undefined,
		});
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.platformIam.deleteGuardrail(principal, event.params.id!);
		return { deleted: true };
	});

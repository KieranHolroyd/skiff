import type { RequestHandler } from './$types';
import * as z from 'zod';
import type { Condition, ScopeRef } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const scope = z.object({
	type: z.string().min(1),
	id: z.string().min(1).optional(),
	projectId: z.string().min(1).optional()
});

const selector = z
	.object({
		principalTypes: z.array(z.string().min(1)).max(16).optional(),
		principalIds: z.array(z.string().min(1)).max(256).optional(),
		groupIds: z.array(z.string().min(1)).max(256).optional()
	})
	.strict();

const updateGuardrail = z.object({
	name: z.string().min(2).max(80).optional(),
	permissions: z.array(z.string().min(1).max(120)).min(1).max(500).optional(),
	selector: selector.optional(),
	scope: scope.optional(),
	condition: z
		.object({ op: z.string().min(1) })
		.passthrough()
		.nullable()
		.optional(),
	enabled: z.boolean().optional()
});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, updateGuardrail);
		return core.governance.update(principal, event.params.id!, {
			...input,
			scope: input.scope as ScopeRef | undefined,
			condition: input.condition as Condition | null | undefined
		});
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.governance.delete(principal, event.params.id!);
		return { deleted: true };
	});

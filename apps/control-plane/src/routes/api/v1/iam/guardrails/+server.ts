import type { RequestHandler } from './$types';
import * as z from 'zod';
import type { Condition, ScopeRef } from '@yoal/contracts';
import { GUARDRAIL_TEMPLATES } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
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

const condition = z.object({ op: z.string().min(1) }).passthrough();

const createGuardrail = z.object({
	template: z.string().min(1).optional(),
	name: z.string().min(2).max(80).optional(),
	permissions: z.array(z.string().min(1).max(120)).min(1).max(500).optional(),
	selector: selector.optional(),
	scope: scope.optional(),
	condition: condition.nullish(),
	enabled: z.boolean().optional()
});

/**
 * Deny guardrails (IAM.md I11, §9.2). `GET` returns the org's rows, the platform's read-only rows
 * and the built-in templates. Every write is `iam:manage-guardrails`, checked by the service.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return {
			guardrails: core.governance.list(principal),
			templates: GUARDRAIL_TEMPLATES,
			can: {
				manage: core.iam.can(principal, 'iam:manage-guardrails', { type: 'org' })
			}
		};
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, createGuardrail);
		return json(
			core.governance.create(principal, {
				...input,
				scope: input.scope as ScopeRef | undefined,
				condition: input.condition as Condition | null | undefined
			}),
			201
		);
	});

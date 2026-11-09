import type { RequestHandler } from './$types';
import * as z from 'zod';
import type { Condition, ScopeRef } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const scope = z.object({
	type: z.enum([
		'platform',
		'org',
		'project',
		'environment',
		'deployment',
		'secret',
		'build',
		'database',
		'storage',
		'broker',
		'emailDomain',
		'shareLink',
		'container',
		'repository',
		'pipelineRepository',
		'userPool',
		'accessPolicy',
		'apiKey',
	]),
	id: z.string().min(1).optional(),
	projectId: z.string().min(1).optional(),
});

const simulateDraft = z.object({
	sample: z.object({
		principalType: z.enum(['user', 'serviceAccount']),
		principalId: z.string().min(1),
	}),
	change: z.discriminatedUnion('kind', [
		z.object({
			kind: z.literal('binding'),
			roleId: z.string().min(1).max(80),
			scope,
			expiresAt: z.number().int().positive().optional(),
			condition: z.object({ op: z.string().min(1) }).passthrough().optional(),
		}),
		z.object({
			kind: z.literal('role'),
			roleId: z.string().min(1).max(80),
			permissions: z.array(z.string().min(1)).min(1),
		}),
	]),
});

/**
 * Dry-run a draft binding or custom-role edit (IAM.md §9.3, I12). The service checks `iam:read`
 * and returns the decisions that would flip for the sample principal; nothing is saved.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, simulateDraft);
		const change = input.change;
		return core.iam.simulate(principal, {
			sample: input.sample,
			change:
				change.kind === 'binding'
					? {
							...change,
							scope: change.scope as ScopeRef,
							condition: change.condition as Condition | undefined,
						}
					: change,
		});
	});

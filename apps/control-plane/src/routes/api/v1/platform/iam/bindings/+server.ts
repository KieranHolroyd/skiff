import type { RequestHandler } from './$types';
import * as z from 'zod';
import { platformRoleIds, type Condition } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const roleId = z.enum(platformRoleIds as [string, ...string[]]);

const condition = z.object({ op: z.string().min(1) }).passthrough();

const createBinding = z
	.object({
		userId: z.string().min(1).max(128).optional(),
		groupId: z.string().min(1).max(128).optional(),
		roleId,
		/** Null is deliberate: D129's quota exception is a binding without the session-only condition. */
		condition: condition.nullish(),
		expiresAt: z.number().int().positive().nullish(),
		reason: z.string().max(500).optional(),
	})
	.refine((input) => Boolean(input.userId) !== Boolean(input.groupId), {
		message: 'Provide exactly one of userId or groupId.',
	});

/**
 * Platform role bindings (IAM.md I24, §10). `GET` lists every platform binding; `POST` binds a
 * user or group to `platform-admin|operator|viewer`. The service requires a platform administrator
 * for writes and keeps D129's session-only default for `platform-admin`.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return {
			bindings: core.platformIam.list(principal),
			roles: platformRoleIds,
			can: {
				administer: core.platformIam.canAdminister(principal),
			},
		};
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, createBinding);
		return json(
			core.platformIam.bind(principal, {
				...(input.groupId ? { groupId: input.groupId } : { userId: input.userId! }),
				roleId: input.roleId,
				...(input.condition === undefined
					? {}
					: { condition: input.condition as Condition | null }),
				expiresAt: input.expiresAt ?? null,
				reason: input.reason,
			}),
			201,
		);
	});

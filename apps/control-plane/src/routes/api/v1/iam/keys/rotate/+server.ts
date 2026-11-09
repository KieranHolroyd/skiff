import type { RequestHandler } from './$types';
import * as z from 'zod';
import { AUTO_ROTATION_PURPOSES, ForbiddenError, ValidationError } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const rotateRequest = z
	.object({
		purpose: z.string().trim().min(1).max(120).optional(),
		all: z.boolean().optional(),
	})
	.strict();

/**
 * Rotate one signing-key purpose, or every automatically rotated purpose (IAM.md I15, §7.3).
 * `rotate` publishes a `next` key and promotes the previous one, so a purpose always keeps a
 * signer. Platform maintenance is required; `pool:<id>` keys rotate with their pool and are never
 * part of `all`.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		if (!core.ctx.platformIam.canMaintain(principal))
			throw new ForbiddenError(
				'platform:maintenance',
				'rotating signing keys is a platform maintenance operation',
			);

		const input = await readJson(event.request, rotateRequest);
		if (input.all && input.purpose)
			throw new ValidationError('Use either purpose or all, not both.');
		if (!input.all && !input.purpose)
			throw new ValidationError('Name a purpose to rotate, or pass all.');

		const purposes = input.all ? [...AUTO_ROTATION_PURPOSES] : [input.purpose!];
		const rotations = [];
		for (const purpose of purposes)
			rotations.push(await core.ctx.signingKeys.rotate(purpose, principal));
		return { rotations, rotatedAt: core.ctx.now() };
	});

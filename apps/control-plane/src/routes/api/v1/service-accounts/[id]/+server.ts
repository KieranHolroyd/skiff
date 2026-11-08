import * as z from 'zod';
import type { RequestHandler } from './$types';
import { SLUG_MAX, SLUG_MIN, SLUG_PATTERN } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One service account. Disabling is the normal off-switch; delete is refused while bound. */

const nameSchema = z
	.string()
	.trim()
	.toLowerCase()
	.min(SLUG_MIN)
	.max(SLUG_MAX)
	.regex(
		SLUG_PATTERN,
		'Use lowercase letters, digits and single hyphens; start and end with a letter or digit.',
	);

const updateSchema = z.object({
	name: nameSchema.optional(),
	description: z.string().max(1000).optional(),
	ownerGroupId: z.string().min(1).max(100).nullable().optional(),
	disabled: z.boolean().optional(),
});

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { serviceAccount: core.serviceAccounts.get(principal, event.params.id) };
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, updateSchema);
		return { serviceAccount: core.serviceAccounts.update(principal, event.params.id, input) };
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.serviceAccounts.delete(principal, event.params.id);
		return { ok: true };
	});

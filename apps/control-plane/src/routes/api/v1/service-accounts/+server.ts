import * as z from 'zod';
import type { RequestHandler } from './$types';
import { SLUG_MAX, SLUG_MIN, SLUG_PATTERN } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Service accounts (IAM.md I13, §12). This endpoint owns the accounts; keys and impersonation
 * tokens hang off `/service-accounts/:id/{keys,token}`. Every check lives in
 * `core.serviceAccounts`.
 */

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

const createSchema = z.object({
	name: nameSchema,
	description: z.string().max(1000).optional(),
	ownerGroupId: z.string().min(1).max(100).nullable().optional(),
});

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { serviceAccounts: core.serviceAccounts.list(principal) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, createSchema);
		return json(core.serviceAccounts.create(principal, input), 201);
	});

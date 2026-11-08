import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const createRole = z.object({
	name: z.string().min(2).max(40),
	description: z.string().max(500).optional(),
	permissions: z.array(z.string().min(1)).min(1),
});

/** Custom roles (IAM.md §3, I8). The service checks `iam:manage-roles` and validates the catalog. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, createRole);
		return json(core.iam.createRole(principal, input), 201);
	});

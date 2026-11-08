import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const createGroup = z.object({
	name: z.string().min(2).max(40),
	description: z.string().max(500).optional(),
});

/** Groups are the target for team-wide bindings (IAM.md I9). */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, createGroup);
		return json(core.iam.createGroup(principal, input), 201);
	});

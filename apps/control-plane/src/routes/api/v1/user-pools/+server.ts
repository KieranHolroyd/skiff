import type { RequestHandler } from './$types';
import { userPoolCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Managed user pools (IAM.md I26–I29, §11.2). A pool is an org resource like a database; its
 * end users, sessions and hosted sign-in belong to the native identity engine, not this endpoint.
 */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { pools: core.userPools.list(principal) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, userPoolCreateSchema);
		return json(await core.userPools.create(principal, input), 201);
	});

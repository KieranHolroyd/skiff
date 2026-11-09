import type { RequestHandler } from './$types';
import { userPoolUpdateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One user pool. Disabling keeps its clients and signing key; deleting removes both. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { pool: core.userPools.get(principal, event.params.id) };
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, userPoolUpdateSchema);
		return { pool: core.userPools.update(principal, event.params.id, input) };
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.userPools.delete(principal, event.params.id);
		return { ok: true };
	});

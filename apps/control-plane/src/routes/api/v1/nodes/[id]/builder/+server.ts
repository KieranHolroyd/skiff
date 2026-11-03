import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const builderSchema = z.object({ builder: z.boolean().default(true) });

/** Platform-admin only: mark a node as a git Builder (D3). */
export const POST: RequestHandler = async (event) => {
	const principal = requirePrincipal(event);
	return route(async () => {
		if (event.request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
		const input = await readJson(event.request, builderSchema);
		return core.nodes.setBuilder(principal, event.params.id, input.builder);
	});
};

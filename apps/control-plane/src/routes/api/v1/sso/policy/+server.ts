import type { RequestHandler } from './$types';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { core } from '#lib/server/core.js';
import { authPolicyUpdateSchema } from '../_schema.js';

/**
 * Org authentication policy (IAM.md I21, §12). `sso:read` reads it; `sso:manage` writes it. The
 * session limits are in seconds (`null` turns a limit off).
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { policy: core.authPolicy.get(principal) };
	});

export const PUT: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, authPolicyUpdateSchema);
		return json(core.authPolicy.update(principal, input));
	});

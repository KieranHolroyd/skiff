import type { RequestHandler } from './$types';
import { accessServiceTokenCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Named machine tokens for a policy (IAM.md I25, §11.1). */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json(core.accessPolicies.listServiceTokens(principal, event.params.id));
	});

/** Create one. The raw `yoal_svc_…` secret is in the response and is never returned again. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, accessServiceTokenCreateSchema);
		return json(core.accessPolicies.createServiceToken(principal, event.params.id, input), 201, {
			'cache-control': 'no-store',
		});
	});

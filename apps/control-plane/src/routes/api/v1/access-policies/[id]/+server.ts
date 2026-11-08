import type { RequestHandler } from './$types';
import { accessPolicyUpdateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json(core.accessPolicies.get(principal, event.params.id));
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, accessPolicyUpdateSchema);
		return json(core.accessPolicies.update(principal, event.params.id, input));
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.accessPolicies.remove(principal, event.params.id);
		return json({ ok: true });
	});

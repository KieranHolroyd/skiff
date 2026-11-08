import type { RequestHandler } from './$types';
import { registrySettingsUpdateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The platform registry (docs/REGISTRY.md G1): its host and status; settings for platform admins. */
export const GET: RequestHandler = (event) =>
	route(() => ({ registry: core.registry.view(requirePrincipal(event)) }));

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, registrySettingsUpdateSchema);
		return { registry: core.registry.update(principal, input) };
	});

import type { RequestHandler } from './$types';
import { registryCredentialUpdateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, registryCredentialUpdateSchema);
		return { credential: core.registryCredentials.update(principal, event.params.name, input) };
	});

export const PUT = PATCH;

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.registryCredentials.remove(principal, event.params.name);
		return { deleted: true };
	});

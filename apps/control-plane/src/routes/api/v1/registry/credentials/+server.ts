import type { RequestHandler } from './$types';
import { registryCredentialCreateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Credentials for external container registries (docs/REGISTRY.md R2). Passwords are write-only. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { credentials: core.registryCredentials.list(principal) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, registryCredentialCreateSchema);
		return json({ credential: core.registryCredentials.create(principal, input) }, 201);
	});

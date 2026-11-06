import type { RequestHandler } from './$types';
import { databaseStudioOpenSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The caller's native studio session (plan 22). GET reads it; POST opens; DELETE closes. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { studio: core.databaseStudio.view(principal, event.params.name) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, databaseStudioOpenSchema);
		return json({ studio: core.databaseStudio.open(principal, event.params.name, input) }, 201);
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { studio: core.databaseStudio.close(principal, event.params.name) };
	});

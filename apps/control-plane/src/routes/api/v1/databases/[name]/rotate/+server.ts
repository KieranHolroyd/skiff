import type { RequestHandler } from './$types';
import { databaseRotateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Rotate the owner or monitor password; the node applies ALTER ROLE before the secret swaps. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { rotations: core.databases.rotations(principal, event.params.name) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, databaseRotateSchema);
		return json(
			{ rotation: core.databases.rotateCredentials(principal, event.params.name, input) },
			202,
		);
	});

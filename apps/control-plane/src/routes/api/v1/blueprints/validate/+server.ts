import type { RequestHandler } from './$types';
import { blueprintValidateRequestSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Parse and check a blueprint without reading live state; problems are a 422 with exact paths. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, blueprintValidateRequestSchema);
		return { validation: core.blueprints.validate(principal, input.document) };
	});

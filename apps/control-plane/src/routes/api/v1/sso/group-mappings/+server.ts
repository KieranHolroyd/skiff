import type { RequestHandler } from './$types';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { sso } from '#lib/server/sso.js';
import { groupMappingSchema } from '../_schema.js';

/** IdP group claim → Yoal group (IAM.md I19, §8.3). */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { mappings: sso.listGroupMappings(principal) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, groupMappingSchema);
		return json(sso.saveGroupMapping(principal, input), 201);
	});

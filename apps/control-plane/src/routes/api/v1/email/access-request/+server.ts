import type { RequestHandler } from './$types';
import { emailAccessRequestCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * The org's request to leave the email sandbox (EMAIL.md §7.3). GET returns the latest one (null if
 * it never asked); POST, by an org owner or admin, asks a platform admin to move the org to active.
 */

export const GET: RequestHandler = (event) =>
	route(() => ({ request: core.email.accessRequest(requirePrincipal(event)) }));

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, emailAccessRequestCreateSchema);
		return json({ request: await core.email.requestProductionAccess(principal, input) }, 201);
	});

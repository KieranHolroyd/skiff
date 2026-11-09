import * as z from 'zod';
import type { RequestHandler } from './$types';
import { emailOrgStates } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Move an org out of (or back into) the sandbox, pause it, or change its limits (D119). Platform admin session only. */
const orgStateSchema = z.object({
	state: z.enum(emailOrgStates).optional(),
	perSecond: z.number().int().optional(),
	perDay: z.number().int().optional()
});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, orgStateSchema);
		return { org: core.email.setOrgState(principal, event.params.orgId, input) };
	});

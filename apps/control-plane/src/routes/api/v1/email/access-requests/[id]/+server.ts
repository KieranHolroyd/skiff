import type { RequestHandler } from './$types';
import { emailAccessRequestDecisionSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Decide a production access request: `{ decision: 'approve', perDay?, perSecond?, note? }` moves the
 * org to active; `{ decision: 'deny', note }` keeps it in the sandbox. Platform admin session only.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, emailAccessRequestDecisionSchema);
		return { request: await core.email.decideAccessRequest(principal, event.params.id, input) };
	});

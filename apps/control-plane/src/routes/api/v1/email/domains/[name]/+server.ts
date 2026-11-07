import type { RequestHandler } from './$types';
import { emailDomainUpdateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One sending domain. DELETE removes it (and the records Skiff created in Cloudflare) at once. */

export const GET: RequestHandler = (event) =>
	route(() => ({ domain: core.email.getDomain(requirePrincipal(event), event.params.name) }));

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, emailDomainUpdateSchema);
		return { domain: core.email.updateDomain(principal, event.params.name, input) };
	});

export const DELETE: RequestHandler = (event) =>
	route(async () => {
		await core.email.deleteDomain(requirePrincipal(event), event.params.name);
		return new Response(null, { status: 204 });
	});

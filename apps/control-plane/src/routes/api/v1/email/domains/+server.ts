import type { RequestHandler } from './$types';
import { emailDomainCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Sending domains (EMAIL.md §4.1, D116). Each view carries its DNS records and their last check. */

export const GET: RequestHandler = (event) =>
	route(() => ({ domains: core.email.listDomains(requirePrincipal(event)) }));

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, emailDomainCreateSchema);
		return json({ domain: await core.email.createDomain(principal, input) }, 201);
	});

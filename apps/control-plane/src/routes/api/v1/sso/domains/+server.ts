import type { RequestHandler } from './$types';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { sso } from '#lib/server/sso.js';
import { domainCreateSchema } from '../_schema.js';

/**
 * Verified SSO email domains (IAM.md §8.3). Adding a domain publishes `skiff-verify=<token>` as a
 * TXT record and checks it at once; `GET` also re-checks any domain whose last check is a day old,
 * so no scheduler work is needed for the daily check.
 */

export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		return { domains: await sso.recheckDueDomains(principal) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, domainCreateSchema);
		return json(await sso.addDomain(principal, input.domain), 201);
	});

/** Collection-level delete (`?domain=example.com`) for clients that do not use path params. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const domain = event.url.searchParams.get('domain')?.trim() ?? '';
		sso.removeDomain(principal, domain);
		return { ok: true };
	});

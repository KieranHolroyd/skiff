import type { RequestHandler } from './$types';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { sso } from '#lib/server/sso.js';
import { providerCreateSchema } from '../_schema.js';

/**
 * SSO providers (IAM.md I19, §12). One OIDC provider per organisation in this slice. The client
 * secret is write-only: it is sealed with the organisation key and never returned.
 */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { providers: sso.listProviders(principal) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, providerCreateSchema);
		return json(await sso.createProvider(principal, input), 201);
	});

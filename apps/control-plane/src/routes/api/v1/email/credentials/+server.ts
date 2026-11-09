import type { RequestHandler } from './$types';
import { emailCredentialCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * SMTP/API credentials (EMAIL.md §5.4). The password is returned once, at creation, and never
 * again; creating one needs `email:credentials` and a person (D58), so MCP has no equivalent.
 */

export const GET: RequestHandler = (event) =>
	route(() => ({ credentials: core.email.listCredentials(requirePrincipal(event)) }));

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, emailCredentialCreateSchema);
		const credential = core.email.createCredential(principal, input);
		return json({ credential }, 201, { 'cache-control': 'no-store' });
	});

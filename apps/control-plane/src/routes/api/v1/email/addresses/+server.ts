import type { RequestHandler } from './$types';
import { emailSandboxAddressCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Sandbox recipients (EMAIL.md §4.3): single addresses an org in the sandbox may send to once their
 * owner confirmed a link. POST adds one and mails the link, or sends a fresh link to one still pending.
 */

export const GET: RequestHandler = (event) =>
	route(() => ({ addresses: core.email.listSandboxAddresses(requirePrincipal(event)) }));

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, emailSandboxAddressCreateSchema);
		const address = await core.email.addSandboxAddress(principal, input);
		return json({ address }, address.status === 'verified' ? 200 : 201);
	});

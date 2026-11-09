import * as z from 'zod';
import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Impersonation token for a service account (IAM.md I13, §7.2). Needs
 * `serviceAccount:impersonate`; the token is an STS token signed by the ring, lasts at most one
 * hour, and is audited. It carries the account's bindings, not the caller's.
 */

const bodySchema = z.object({
	/** Seconds; the core caps it at one hour. */
	ttl: z.number().int().positive().max(3600).optional(),
	audience: z.string().trim().min(1).max(512).optional(),
});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, bodySchema);
		const token = await core.serviceAccounts.impersonate(principal, event.params.id, input);
		return json(
			{
				access_token: token.accessToken,
				token_type: token.tokenType,
				expires_in: token.expiresIn,
				audience: token.audience,
				service_account: token.serviceAccount,
			},
			201,
		);
	});

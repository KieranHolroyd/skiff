import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { platformOrigin } from '#lib/server/config.js';

/**
 * SCIM bearer credentials (IAM.md I20, §8.4). `GET` lists them without the secret; `POST` mints a
 * token and returns it once. The protocol endpoint is `/api/auth/scim/v2`.
 */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return {
			endpoint: `${platformOrigin}/api/auth/scim/v2`,
			tokens: core.scim.list(principal)
		};
	});

export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const created = core.scim.create(principal);
		return json(
			{
				...created,
				endpoint: `${platformOrigin}/api/auth/scim/v2`
			},
			201
		);
	});

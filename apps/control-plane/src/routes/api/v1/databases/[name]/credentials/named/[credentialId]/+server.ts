import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Reveal one credential's password. Gated exactly like `GET …/credentials` (D58): it needs
 * `database:credentials`, MCP principals are refused in core, and every read is audited as
 * `database.credentials.reveal`.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const credential = core.databases.revealCredential(principal, event.params.name, event.params.credentialId);
		return json({ credential }, 200, { 'cache-control': 'no-store' });
	});

/** Revoke a named credential: the node disables the role's login. Refused while an app uses it. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json(
			{ credential: core.databases.revokeCredential(principal, event.params.name, event.params.credentialId) },
			202,
		);
	});

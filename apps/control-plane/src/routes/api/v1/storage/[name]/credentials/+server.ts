import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Reveal the instance's root key (S6). Needs `storage:credentials`, which is never pre-ticked for
 * agents; every read is audited by core. MCP has no equivalent.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const credentials = core.storage.credentials(principal, event.params.name);
		return json({ credentials }, 200, { 'cache-control': 'no-store' });
	});

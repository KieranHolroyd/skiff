import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Reveal a named key's secret. Same policy as the root key (D67): `storage:credentials`, a user
 * session or API key, never MCP. Every read is audited by core.
 */
export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const key = core.storage.revealKey(principal, event.params.name, event.params.id);
		return json({ key }, 200, { 'cache-control': 'no-store' });
	});

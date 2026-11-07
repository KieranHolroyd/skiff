import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Reveal the connection URL and password (as D58). Needs `broker:credentials` (a dashboard session
 * or an API key holding it, as the CLI uses); every read is audited by core. MCP has no equivalent.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const credentials = core.brokers.credentials(principal, event.params.name);
		return json({ credentials }, 200, { 'cache-control': 'no-store' });
	});

import type { RequestHandler } from './$types';
import { ValidationError } from '@skiff/core';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * MCP/OAuth clients you have approved (Settings → Connected apps). `?scope=org` lists every
 * member's grants in the organisation instead (owners and admins: `member:remove`).
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const scope = event.url.searchParams.get('scope') ?? 'mine';
		if (scope !== 'mine' && scope !== 'org') throw new ValidationError('scope must be "mine" or "org".');
		return { connectedApps: core.connectedApps.list(principal, { scope }) };
	});

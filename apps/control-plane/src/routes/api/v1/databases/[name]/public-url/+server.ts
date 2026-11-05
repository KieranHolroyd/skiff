import type { RequestHandler } from './$types';
import { databasePublicUrlUpdateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * The operator-managed public database URL. The value is sealed at rest; GET is the only decrypt
 * path and is audited. Never include it in the database view or desired state.
 */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json({ publicUrl: core.databases.revealPublicUrl(principal, event.params.name) }, 200, {
			'cache-control': 'no-store'
		});
	});

export const PUT: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, databasePublicUrlUpdateSchema);
		return { publicUrl: core.databases.setPublicUrl(principal, event.params.name, input) };
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { publicUrl: core.databases.clearPublicUrl(principal, event.params.name) };
	});

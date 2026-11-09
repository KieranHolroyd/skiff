import type { RequestHandler } from './$types';
import { databasePitrPolicySchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * PITR policy and status for one database (docs/PITR.md). Behind `YOAL_FEATURE_PITR`; every
 * mutating call fails closed while the flag is off. Repository credentials are never returned.
 */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { pitr: core.databases.pitrStatus(principal, event.params.name) };
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, databasePitrPolicySchema);
		return { pitr: core.databases.setPitrPolicy(principal, event.params.name, input) };
	});

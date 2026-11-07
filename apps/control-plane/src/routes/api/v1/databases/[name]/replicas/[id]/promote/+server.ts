import type { RequestHandler } from './$types';
import { databaseReplicaPromoteSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Promote a replica to primary (docs/CLUSTERING.md §9.3): fence the old primary, `pg_ctl promote`,
 * hand over the data directory, re-point consumers. `If-Match: <primaryGeneration>` refuses a
 * stale view (412). Body `{ confirm: true, acceptDataLoss? }`. Not available over MCP.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, databaseReplicaPromoteSchema);
		const header = event.request.headers.get('if-match')?.replace(/^W\//, '').replace(/"/g, '').trim();
		const ifMatch = header ? Number(header) : null;
		if (header && !Number.isInteger(ifMatch)) return json({ error: 'If-Match must be the primary generation (an integer).' }, 400);
		return json(
			{ failover: core.databaseReplicas.promote(principal, event.params.name, event.params.id, input, { ifMatch }) },
			202,
		);
	});

import type { RequestHandler } from './$types';
import { databaseReplicaCreateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Read replicas of a database (docs/CLUSTERING.md §9.2) and its promotion history. The primary
 * generation is what `POST …/replicas/:id/promote` takes as `If-Match`.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const database = core.databases.get(principal, event.params.name);
		return {
			primaryGeneration: database.primaryGeneration,
			replicas: core.databaseReplicas.list(principal, event.params.name),
			failovers: core.databaseReplicas.failovers(principal, event.params.name),
		};
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, databaseReplicaCreateSchema);
		return json({ replica: core.databaseReplicas.add(principal, event.params.name, input) }, 201);
	});

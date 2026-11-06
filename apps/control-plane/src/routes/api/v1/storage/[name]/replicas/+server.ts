import type { RequestHandler } from './$types';
import { storageReplicationCreateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { replicas: core.storageReplication.list(principal, event.params.name) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, storageReplicationCreateSchema);
		return { replication: core.storageReplication.add(principal, event.params.name, input) };
	});

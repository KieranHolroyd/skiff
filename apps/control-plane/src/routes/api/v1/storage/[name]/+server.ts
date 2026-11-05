import type { RequestHandler } from './$types';
import { storageUpdateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * One storage instance. DELETE is the soft delete (S8); `DELETE ?purge=1` on an instance that is
 * already in the trash asks its node to remove the data now.
 */

const truthy = (value: string | null) => value === '1' || value === 'true';

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const includeDeleted = truthy(event.url.searchParams.get('includeDeleted'));
		return { storage: core.storage.get(principal, event.params.name, { includeDeleted }) };
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, storageUpdateSchema);
		return { storage: core.storage.update(principal, event.params.name, input) };
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		if (truthy(event.url.searchParams.get('purge'))) {
			core.storage.purgeNow(principal, event.params.name);
			return { ok: true };
		}
		return { storage: core.storage.delete(principal, event.params.name) };
	});

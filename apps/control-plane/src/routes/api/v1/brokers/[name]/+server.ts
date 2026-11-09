import type { RequestHandler } from './$types';
import { brokerUpdateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * One managed broker. DELETE is the soft delete (D59); `DELETE ?purge=1` on a broker that is
 * already in the trash asks its node to remove the data now.
 */

const truthy = (value: string | null) => value === '1' || value === 'true';

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const includeDeleted = truthy(event.url.searchParams.get('includeDeleted'));
		return { broker: core.brokers.get(principal, event.params.name, { includeDeleted }) };
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, brokerUpdateSchema);
		return { broker: core.brokers.update(principal, event.params.name, input) };
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		if (truthy(event.url.searchParams.get('purge'))) {
			core.brokers.purgeNow(principal, event.params.name);
			return { ok: true };
		}
		return { broker: core.brokers.delete(principal, event.params.name) };
	});

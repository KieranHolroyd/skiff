import type { RequestHandler } from './$types';
import { brokerCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Managed queue brokers (docs/BROKERS.md, D111). Every check lives in `core.brokers`. */

const truthy = (value: string | null) => value === '1' || value === 'true';

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const includeDeleted = truthy(event.url.searchParams.get('includeDeleted'));
		return { brokers: core.brokers.list(principal, { includeDeleted }) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, brokerCreateSchema);
		return json({ broker: core.brokers.create(principal, input) }, 201);
	});

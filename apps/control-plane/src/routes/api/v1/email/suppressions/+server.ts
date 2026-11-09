import type { RequestHandler } from './$types';
import { emailSuppressionCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The org's suppression list (EMAIL.md §7.1): `?limit (≤1000)&address=<exact address>`. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const params = event.url.searchParams;
		const limit = Number(params.get('limit') ?? 100);
		return {
			suppressions: core.email.listSuppressions(principal, {
				...(Number.isFinite(limit) ? { limit } : {}),
				...(params.get('address') ? { address: params.get('address')! } : {})
			})
		};
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, emailSuppressionCreateSchema);
		return json({ suppression: core.email.addSuppression(principal, input) }, 201);
	});

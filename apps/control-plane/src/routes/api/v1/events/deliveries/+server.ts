import type { RequestHandler } from './$types';
import { eventDeliveryStatuses, type EventDeliveryStatus } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Recent deliveries, newest first: `?rule=<id>&status=pending|delivered|failed&limit=50`. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const params = event.url.searchParams;
		const status = params.get('status');
		const limit = Number(params.get('limit') ?? 50);
		return {
			deliveries: core.events.deliveries(principal, {
				...(params.get('rule') ? { ruleId: params.get('rule')! } : {}),
				...(status && (eventDeliveryStatuses as readonly string[]).includes(status)
					? { status: status as EventDeliveryStatus }
					: {}),
				...(Number.isFinite(limit) ? { limit } : {})
			})
		};
	});

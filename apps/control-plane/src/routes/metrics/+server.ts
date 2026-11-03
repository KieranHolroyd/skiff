import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';

/**
 * Prometheus exposition on the control plane (DESIGN §8). Reachable on the platform origin; the
 * Caddy config can restrict it to the WireGuard interface if desired.
 */
export const GET: RequestHandler = async () =>
	new Response(await core.metrics.prometheus(), {
		headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' },
	});

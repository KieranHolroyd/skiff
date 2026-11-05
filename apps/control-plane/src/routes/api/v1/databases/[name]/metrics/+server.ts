import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { parseDatabaseMetricsRange } from '../../_lib/metrics-range.ts';

/** `?from&to&interval`: defaults to the last hour at 1m; ranges over 48 h use 1h (D57). */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const range = parseDatabaseMetricsRange(event.url.searchParams);
		const points = await core.databases.metrics(principal, event.params.name, range);
		return { points, interval: range.interval };
	});

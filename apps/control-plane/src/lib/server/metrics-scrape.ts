import type { RequestEvent } from '@sveltejs/kit';
import { MetricsExporter, PROMETHEUS_CONTENT_TYPE, UnauthorizedError } from '@yoal/core';
import { core } from './core';
import { route } from './api';

/**
 * Prometheus scrape for `/metrics[/<section>[/<name>]]` and `/api/v1/metrics/...` (docs/METRICS.md).
 * No credentials: the fleet summary, when Settings → Metrics allows it. A session or
 * `Authorization: Bearer yoal_…` key: the key's org, scoped by the path. A bearer header that does
 * not resolve is a 401, never a silent fall-back to the public view.
 */
export function scrape(event: RequestEvent, segments: string[]): Promise<Response> {
	return route(async () => {
		if (event.request.method !== 'GET' && event.request.method !== 'HEAD')
			return Response.json({ error: 'method_not_allowed' }, { status: 405 });
		const principal = event.locals.principal;
		if (!principal && event.request.headers.get('authorization')) throw new UnauthorizedError('Invalid API key.');
		const text = await core.metricsExport.render(principal, MetricsExporter.scopeFromPath(segments));
		return new Response(event.request.method === 'HEAD' ? null : text, {
			headers: { 'content-type': PROMETHEUS_CONTENT_TYPE, 'cache-control': 'no-store' },
		});
	});
}

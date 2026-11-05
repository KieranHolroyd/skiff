import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Read-only usage for the caller's org or one project (plan 16). `?project=<slug>` scopes it,
 * `?format=csv` exports the same numbers for showback, and `?history=1` returns the daily points.
 */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = event.url.searchParams.get('project') || undefined;
		const options = project ? { projectSlug: project } : {};
		if (event.url.searchParams.get('history') === '1' || event.url.searchParams.get('history') === 'true')
			return core.usage.history(principal, options);
		const view = await core.usage.view(principal, options);
		if (event.url.searchParams.get('format') === 'csv') {
			const scope = view.projectSlug ? `-${view.projectSlug}` : '';
			return new Response(core.usage.csv(view), {
				headers: {
					'content-type': 'text/csv; charset=utf-8',
					'content-disposition': `attachment; filename="skiff-usage${scope}-${view.at.slice(0, 10)}.csv"`,
					'cache-control': 'no-store',
				},
			});
		}
		return view;
	});

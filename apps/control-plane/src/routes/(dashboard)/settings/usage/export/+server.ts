import { error } from '@sveltejs/kit';
import { hasPermission } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import type { RequestHandler } from './$types';

/** CSV export for Settings → Usage; the same numbers the cards show (plan 16). */
export const GET: RequestHandler = async ({ locals }) => {
	const principal = locals.principal;
	if (!principal || !hasPermission(principal, 'project:read'))
		error(403, 'You need permission to read projects to export usage.');
	const view = await core.usage.view(principal);
	return new Response(core.usage.csv(view), {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="yoal-usage-${view.at.slice(0, 10)}.csv"`,
			'cache-control': 'no-store'
		}
	});
};

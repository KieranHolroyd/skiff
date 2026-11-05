import { error } from '@sveltejs/kit';
import { hasPermission } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import type { PageServerLoad } from './$types';

/** Settings → Usage: org quotas, current usage and the 30-day trend (plan 16). */
export const load: PageServerLoad = async ({ locals }) => {
	const principal = locals.principal!;
	if (!hasPermission(principal, 'project:read'))
		error(403, 'You need permission to read projects to see usage.');

	const [view, quotas, history, projects] = await Promise.all([
		core.usage.view(principal),
		core.usage.quotas(principal),
		core.usage.history(principal),
		Promise.resolve(core.projects.list(principal)),
	]);
	return {
		view,
		quotas,
		history,
		projects,
		canSetQuotas: principal.platformAdmin === true,
	};
};

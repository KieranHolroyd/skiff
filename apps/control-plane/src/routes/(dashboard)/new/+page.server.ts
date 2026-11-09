import { featureEnabled } from '@yoal/core';
import { core } from '#lib/server/core.js';
import type { PageServerLoad } from './$types';

/** The "new" hub: start from a blank runtime or from a first-party template (plan 21). */
export const load: PageServerLoad = ({ locals }) => {
	let templates: ReturnType<typeof core.templates.list> = [];
	try {
		templates = core.templates.list(locals.principal!);
	} catch {
		// No project:read; the catalog is simply hidden.
	}
	// Blueprints (plan 11) are offered once an operator turns them on.
	return { templates, blueprints: featureEnabled(core.ctx.config, 'BLUEPRINTS') };
};

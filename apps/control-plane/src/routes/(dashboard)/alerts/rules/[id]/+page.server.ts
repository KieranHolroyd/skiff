import { core } from '#lib/server/core.js';
import type { PageServerLoad } from './$types';

/**
 * Only the breadcrumb label: the page loads the rule client-side (TanStack Query). Not found or
 * forbidden falls through to the page, which shows its own message.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	try {
		return { crumbLabel: core.alerts.getRule(locals.principal!, params.id).name };
	} catch {
		return { crumbLabel: null };
	}
};

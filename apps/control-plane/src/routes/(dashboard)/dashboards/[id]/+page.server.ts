import { core } from '#lib/server/core.js';
import type { PageServerLoad } from './$types';

/**
 * Only the breadcrumb label: the page itself loads the dashboard client-side (TanStack Query).
 * Not found or forbidden falls through to the page, which shows its own message.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	try {
		return { crumbLabel: core.observability.get(locals.principal!, params.id).title };
	} catch {
		return { crumbLabel: null };
	}
};

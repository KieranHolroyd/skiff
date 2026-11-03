import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Root is a router: authenticated users get the dashboard, everyone else signs in. */
export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.principal) redirect(303, '/overview');
	const redirectTo = `${url.pathname}${url.search}`;
	redirect(303, `/login?redirect=${encodeURIComponent(redirectTo)}`);
};

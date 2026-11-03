import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Invite acceptance (DESIGN §6.1). Requires a session; the page calls Better Auth to join. */
export const load: PageServerLoad = ({ locals, params, url }) => {
	if (!locals.user) redirect(303, `/login?redirect=${encodeURIComponent(url.pathname)}`);
	return { invitationId: params.id, email: locals.user.email };
};

import { redirect } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import { poolSessionToken } from '../_lib/hosted.js';
import type { PageServerLoad } from './$types';

/** A small landing page for a signed-in pool visitor; the real destinations are the client app. */
export const load: PageServerLoad = ({ params, cookies }) => {
	const session = core.userPoolEngine.session(params.id, poolSessionToken(cookies, params.id));
	if (!session) redirect(303, `/pool/${params.id}/login`);
	return { user: session.user };
};

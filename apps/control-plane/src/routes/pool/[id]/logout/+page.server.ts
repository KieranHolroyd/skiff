import { redirect } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import { clearPoolSession, poolSessionToken, validCsrf } from '../../_lib/hosted.js';
import type { Actions } from './$types';

/**
 * Hosted sign-out. A POST (with the page's CSRF token) revokes the pool session and clears its
 * cookie. The OIDC end-session endpoint under `/api/v1/user-pools/:id/oauth/logout` remains the
 * RP-initiated path for an application.
 */
export const actions: Actions = {
	default: async ({ params, request, cookies }) => {
		const form = await request.formData();
		if (validCsrf(cookies, params.id, form.get('csrf'))) {
			core.userPoolEngine.logout(params.id, poolSessionToken(cookies, params.id));
			clearPoolSession(cookies, params.id);
		}
		redirect(303, `/pool/${params.id}/login`);
	}
};

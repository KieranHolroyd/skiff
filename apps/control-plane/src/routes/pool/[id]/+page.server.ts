import { fail, redirect } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import { clientKey, poolSessionToken, validCsrf } from '../_lib/hosted.js';
import type { Actions, PageServerLoad } from './$types';

/** A small landing page for a signed-in pool visitor; the real destinations are the client app. */
export const load: PageServerLoad = ({ params, cookies }) => {
	const session = core.userPoolEngine.session(params.id, poolSessionToken(cookies, params.id));
	if (!session) redirect(303, `/pool/${params.id}/login`);
	return { user: session.user };
};

export const actions: Actions = {
	/** Re-send the verification link an open pool let the visitor skip. */
	resend: async (event) => {
		const { params, request, cookies } = event;
		const session = core.userPoolEngine.session(params.id, poolSessionToken(cookies, params.id));
		if (!session) redirect(303, `/pool/${params.id}/login`);
		const form = await request.formData();
		if (!validCsrf(cookies, params.id, form.get('csrf')))
			return fail(400, { error: 'Your form expired. Reload the page and try again.' });
		await core.userPoolEngine.requestEmailVerification(params.id, session.user.email, {
			ip: clientKey(event)
		});
		return { sent: true };
	}
};

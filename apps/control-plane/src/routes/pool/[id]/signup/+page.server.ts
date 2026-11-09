import { fail, redirect } from '@sveltejs/kit';
import { CoreError } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { platformOrigin } from '#lib/server/config.js';
import { safeRedirect } from '#lib/redirect.js';
import {
	allowAttempt,
	clientKey,
	poolSessionToken,
	setPoolSession,
	validCsrf
} from '../../_lib/hosted.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Hosted pool sign-up. `open` pools create the account immediately; `invite` pools require the
 * invite token from the query string (or a pending invitation for the address). The engine mails
 * the verification link itself, through the platform sender or the mail node.
 */
export const load: PageServerLoad = ({ params, cookies, url }) => {
	const token = poolSessionToken(cookies, params.id);
	if (token && core.userPoolEngine.session(params.id, token)) {
		redirect(
			303,
			safeRedirect(url.searchParams.get('return_to'), platformOrigin, `/pool/${params.id}`)
		);
	}
	return { invite: url.searchParams.get('invite') ?? '' };
};

export const actions: Actions = {
	default: async (event) => {
		const { params, request, cookies, url } = event;
		const form = await request.formData();
		if (!validCsrf(cookies, params.id, form.get('csrf')))
			return fail(400, { error: 'Your sign-up form expired. Reload the page and try again.' });

		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');
		const name = String(form.get('name') ?? '');
		const inviteToken = String(form.get('invite') ?? url.searchParams.get('invite') ?? '');
		if (!email || !password) return fail(400, { error: 'Enter your email and a password.' });

		const client = clientKey(event);
		if (!allowAttempt(`signup:${params.id}:${email.toLowerCase()}:${client}`))
			return fail(429, { error: 'Too many sign-up attempts. Wait a minute and try again.' });

		try {
			const created = await core.userPoolEngine.signUp(
				params.id,
				email,
				password,
				name,
				inviteToken ? { inviteToken } : {}
			);
			if (!created.user.emailVerified && core.userPools.publicInfo(params.id).requireEmailVerification)
				redirect(
					303,
					`/pool/${params.id}/login?verify=email&email=${encodeURIComponent(created.user.email)}`
				);
			const signedIn = await core.userPoolEngine.signIn(params.id, email, password);
			setPoolSession(cookies, params.id, signedIn.token);
			redirect(
				303,
				safeRedirect(
					String(form.get('return_to') ?? url.searchParams.get('return_to')),
					platformOrigin,
					`/pool/${params.id}`
				)
			);
		} catch (error) {
			if (error instanceof CoreError) return fail(error.status, { error: error.message });
			throw error;
		}
	}
};

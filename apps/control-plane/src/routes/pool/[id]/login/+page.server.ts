import { fail, redirect } from '@sveltejs/kit';
import { CoreError } from '@skiff/core';
import { core } from '#lib/server/core.js';
import { platformOrigin } from '#lib/server/config.js';
import { safeRedirect } from '#lib/redirect.js';
import {
	allowAttempt,
	clientKey,
	poolSessionToken,
	validCsrf,
	setPoolSession
} from '../../_lib/hosted.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Hosted pool sign-in (IAM.md §11.2). The form posts to a SvelteKit action, which calls the pool
 * engine directly and sets only the pool's own session cookie. `return_to` is how an OAuth
 * authorize request resumes after sign-in.
 */
export const load: PageServerLoad = ({ params, cookies, url }) => {
	const token = poolSessionToken(cookies, params.id);
	if (token && core.userPoolEngine.session(params.id, token)) {
		redirect(
			303,
			safeRedirect(url.searchParams.get('return_to'), platformOrigin, `/pool/${params.id}`)
		);
	}
	return {
		verified: url.searchParams.get('verified') === '1',
		email: url.searchParams.get('email') ?? ''
	};
};

export const actions: Actions = {
	default: async (event) => {
		const { params, request, cookies, url } = event;
		const form = await request.formData();
		if (!validCsrf(cookies, params.id, form.get('csrf')))
			return fail(400, { error: 'Your sign-in form expired. Reload the page and try again.' });

		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');
		if (!email || !password) return fail(400, { error: 'Enter your email and password.' });

		const client = clientKey(event);
		if (!allowAttempt(`login:${params.id}:${email.toLowerCase()}:${client}`))
			return fail(429, { error: 'Too many sign-in attempts. Wait a minute and try again.' });

		try {
			const result = await core.userPoolEngine.signIn(params.id, email, password);
			setPoolSession(cookies, params.id, result.token);
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

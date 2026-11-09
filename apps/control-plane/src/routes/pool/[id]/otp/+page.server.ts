import { fail, redirect } from '@sveltejs/kit';
import { CoreError } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { platformOrigin } from '#lib/server/config.js';
import { safeRedirect } from '#lib/redirect.js';
import { clientKey, poolSessionToken, setPoolSession, validCsrf } from '../../_lib/hosted.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Hosted email-OTP sign-in (IAM.md §11.2). Requesting a code is enumeration-safe; verifying it
 * starts the same pool session as a password or magic link and marks the address verified.
 */
export const load: PageServerLoad = ({ params, cookies, url }) => {
	const token = poolSessionToken(cookies, params.id);
	if (token && core.userPoolEngine.session(params.id, token))
		redirect(
			303,
			safeRedirect(url.searchParams.get('return_to'), platformOrigin, `/pool/${params.id}`)
		);
	return {
		email: url.searchParams.get('email') ?? '',
		sent: url.searchParams.get('sent') === '1',
		returnTo: url.searchParams.get('return_to')
	};
};

export const actions: Actions = {
	request: async (event) => {
		const { params, request, cookies } = event;
		const form = await request.formData();
		if (!validCsrf(cookies, params.id, form.get('csrf')))
			return fail(400, { error: 'Your form expired. Reload the page and try again.' });
		const email = String(form.get('email') ?? '').trim();
		if (!email) return fail(400, { error: 'Enter your email address.', email });
		try {
			await core.userPoolEngine.requestEmailOtp(params.id, email, { ip: clientKey(event) });
			const next = new URL(event.url);
			next.searchParams.set('email', email);
			next.searchParams.set('sent', '1');
			redirect(303, `${next.pathname}${next.search}`);
		} catch (error) {
			if (error instanceof CoreError) return fail(error.status, { error: error.message, email });
			throw error;
		}
	},

	verify: async (event) => {
		const { params, request, cookies, url } = event;
		const form = await request.formData();
		if (!validCsrf(cookies, params.id, form.get('csrf')))
			return fail(400, { error: 'Your form expired. Reload the page and try again.' });
		const email = String(form.get('email') ?? '').trim();
		const code = String(form.get('code') ?? '').trim();
		if (!email || !code) return fail(400, { error: 'Enter your email and the six-digit code.', email });
		try {
			const result = await core.userPoolEngine.verifyEmailOtp(params.id, email, code, {
				ip: clientKey(event),
				userAgent: request.headers.get('user-agent'),
				country:
					request.headers.get('cf-ipcountry') ?? request.headers.get('x-country-code')
			});
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
			if (error instanceof CoreError) return fail(error.status, { error: error.message, email });
			throw error;
		}
	}
};

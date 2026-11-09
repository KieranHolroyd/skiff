import { fail, redirect } from '@sveltejs/kit';
import { CoreError } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { platformOrigin } from '#lib/server/config.js';
import { safeRedirect } from '#lib/redirect.js';
import { clientKey, setPoolSession, validCsrf } from '../../_lib/hosted.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Hosted password reset. Opening the link only renders the form, so a mail scanner that fetches it
 * does not burn the token; the POST sets the password, revokes every earlier session and starts a
 * fresh one for this browser.
 */
export const load: PageServerLoad = ({ url }) => {
	return { token: url.searchParams.get('token') ?? '', returnTo: url.searchParams.get('return_to') };
};

export const actions: Actions = {
	default: async (event) => {
		const { params, request, cookies, url } = event;
		const form = await request.formData();
		if (!validCsrf(cookies, params.id, form.get('csrf')))
			return fail(400, { error: 'Your reset form expired. Reload the link and try again.' });

		const token = String(form.get('token') ?? '');
		const password = String(form.get('password') ?? '');
		const confirmation = String(form.get('confirm') ?? '');
		if (!token) return fail(400, { error: 'That reset link is invalid or has expired.' });
		if (password !== confirmation) return fail(400, { error: 'The two passwords do not match.' });

		if (!allowResetAttempt(params.id, clientKey(event)))
			return fail(429, { error: 'Too many attempts. Wait a minute and try again.' });

		try {
			const result = await core.userPoolEngine.resetPassword(params.id, token, password);
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

/** A second, looser throttle on the reset form itself; the request endpoint has its own limiter. */
const resetAttempts = new Map<string, number[]>();
function allowResetAttempt(poolId: string, client: string): boolean {
	const now = Date.now();
	const key = `reset:${poolId}:${client}`;
	const recent = (resetAttempts.get(key) ?? []).filter((at) => now - at < 60_000);
	if (recent.length >= 10) return false;
	recent.push(now);
	resetAttempts.set(key, recent);
	return true;
}

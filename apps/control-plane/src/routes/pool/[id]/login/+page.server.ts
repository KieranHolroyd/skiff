import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { CoreError } from '@yoal/core';
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
		verifyEmail: url.searchParams.get('verify') === 'email',
		email: url.searchParams.get('email') ?? '',
		sent: url.searchParams.get('sent'),
		magicError: url.searchParams.get('magic') === 'invalid',
		oauthError: url.searchParams.get('oauth') === 'error',
		/** Only enabled providers: no client id or secret reaches the page. */
		socialProviders: core.userPoolEngine.enabledOAuthProviders(params.id)
	};
};

/** Redirect back to this page with a one-word notice, keeping `return_to`. */
function notice(event: RequestEvent, key: string, value: string): never {
	const next = new URL(event.url);
	next.searchParams.set(key, value);
	redirect(303, `${next.pathname}${next.search}`);
}

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
			const result = await core.userPoolEngine.signIn(params.id, email, password, {
				ip: client,
				userAgent: event.request.headers.get('user-agent'),
				country:
					event.request.headers.get('cf-ipcountry') ??
					event.request.headers.get('x-country-code')
			});
			if (result.mfaRequired) {
				return {
					mfaRequired: true,
					mfaToken: result.mfaToken ?? result.token,
					email
				};
			}
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
	},

	/** Second step: swap a password-verified MFA challenge for a real pool session. */
	mfa: async (event) => {
		const { params, request, cookies, url } = event;
		const form = await request.formData();
		if (!validCsrf(cookies, params.id, form.get('csrf')))
			return fail(400, { error: 'Your sign-in form expired. Reload the page and try again.' });
		const mfaToken = String(form.get('mfaToken') ?? '');
		const code = String(form.get('code') ?? '');
		if (!mfaToken || !code)
			return fail(400, {
				error: 'Enter the six-digit code from your authenticator app.',
				mfaRequired: true,
				mfaToken
			});

		const client = clientKey(event);
		if (!allowAttempt(`mfa:${params.id}:${client}`))
			return fail(429, {
				error: 'Too many code attempts. Wait a minute and try again.',
				mfaRequired: true,
				mfaToken
			});

		try {
			const result = core.userPoolEngine.totpVerify(params.id, mfaToken, code);
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
			if (error instanceof CoreError)
				return fail(error.status, { error: error.message, mfaRequired: true, mfaToken });
			throw error;
		}
	},

	/** Mail a single-use magic link. Always the same response, whether the address exists or not. */
	magic: async (event) => {
		const { params, request, cookies } = event;
		const form = await request.formData();
		if (!validCsrf(cookies, params.id, form.get('csrf')))
			return fail(400, { error: 'Your form expired. Reload the page and try again.' });
		const email = String(form.get('email') ?? '').trim();
		if (!email) return fail(400, { error: 'Enter your email address.' });
		try {
			await core.userPoolEngine.requestMagicLink(params.id, email, { ip: clientKey(event) });
		} catch (error) {
			if (error instanceof CoreError) return fail(error.status, { error: error.message });
			throw error;
		}
		notice(event, 'sent', 'magic');
	},

	/** Mail a single-use password-reset link. Same response for a known and an unknown address. */
	reset: async (event) => {
		const { params, request, cookies } = event;
		const form = await request.formData();
		if (!validCsrf(cookies, params.id, form.get('csrf')))
			return fail(400, { error: 'Your form expired. Reload the page and try again.' });
		const email = String(form.get('email') ?? '').trim();
		if (!email) return fail(400, { error: 'Enter your email address.' });
		try {
			await core.userPoolEngine.requestPasswordReset(params.id, email, { ip: clientKey(event) });
		} catch (error) {
			if (error instanceof CoreError) return fail(error.status, { error: error.message });
			throw error;
		}
		notice(event, 'sent', 'reset');
	},

	/** Send the browser to a configured provider. State and PKCE are created server-side. */
	oauth: async (event) => {
		const { params, request, cookies, url } = event;
		const form = await request.formData();
		if (!validCsrf(cookies, params.id, form.get('csrf')))
			return fail(400, { error: 'Your sign-in form expired. Reload the page and try again.' });
		const provider = String(form.get('provider') ?? '');
		if (!provider) return fail(400, { error: 'Choose a sign-in provider.' });
		if (!allowAttempt(`oauth:${params.id}:${clientKey(event)}`))
			return fail(429, { error: 'Too many sign-in attempts. Wait a minute and try again.' });
		const returnTo = String(form.get('return_to') ?? url.searchParams.get('return_to') ?? '');
		try {
			const started = core.userPoolEngine.oauthStart(params.id, provider, { returnTo });
			redirect(303, started.redirect);
		} catch (error) {
			if (error instanceof CoreError) return fail(error.status, { error: error.message });
			throw error;
		}
	}
};

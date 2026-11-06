import { fail, redirect } from '@sveltejs/kit';
import { auth } from '#lib/server/auth.js';
import { platformOrigin } from '#lib/server/config.js';
import {
	enforceOwnerSecondFactor,
	userHasPasskey,
	userHasPassword,
	userHasSecondFactor,
	userHasTotp
} from '#lib/server/second-factor.js';
import { continueTo, secondFactorState } from '#lib/server/second-factor-policy.js';
import { formPassword, startTotpEnrolment, totpCode, verifyTotpCode } from '#lib/server/totp-enrolment.js';
import { authErrorMessage } from '#lib/server/user-settings.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Owner second-factor challenge and enrolment (D10, see second-factor-policy.ts). Also reachable
 * with `?setup=1` by anyone who wants to add an authenticator app from account settings.
 */

function sessionFactor(locals: App.Locals): string | null {
	return (locals.session as { secondFactor?: string | null } | undefined)?.secondFactor ?? null;
}

export const load: PageServerLoad = ({ locals, url }) => {
	const next = continueTo(url.searchParams.get('redirect'), platformOrigin);
	if (!locals.user || !locals.session)
		redirect(303, `/login?redirect=${encodeURIComponent(`/two-factor${url.search}`)}`);

	const userId = locals.user.id;
	const hasFactor = userHasSecondFactor(userId);
	const state = secondFactorState({
		enforce: enforceOwnerSecondFactor,
		role: locals.principal?.role,
		kind: locals.principal?.kind,
		sessionFactor: sessionFactor(locals),
		hasFactor
	});
	const setup = url.searchParams.get('setup') === '1';
	if (state === 'satisfied' && !setup) redirect(303, next);

	return {
		mode: state === 'satisfied' ? ('setup' as const) : state,
		email: locals.user.email,
		hasPasskey: userHasPasskey(userId),
		hasTotp: userHasTotp(userId),
		hasPassword: userHasPassword(userId),
		redirect: next
	};
};

export const actions: Actions = {
	/** Begin authenticator-app enrolment: returns the otpauth URI and one-time backup codes. */
	startTotp: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { message: 'Sign in first.' });
		if (userHasTotp(locals.user.id))
			return fail(400, { message: 'An authenticator app is already set up for this account.' });
		const started = await startTotpEnrolment(request.headers, formPassword(await request.formData()));
		if (!started.ok) return fail(400, { message: started.message });
		return started.value;
	},

	/** Verify an authenticator code: finishes enrolment, or answers the challenge. */
	verifyTotp: async ({ request, url }) => {
		const value = totpCode(await request.formData());
		if (!value) return fail(400, { message: 'Enter the 6-digit code from your app.', step: 'verify' });
		const verified = await verifyTotpCode(request.headers, value);
		if (!verified.ok) return fail(400, { message: verified.message, step: 'verify' });
		redirect(303, continueTo(url.searchParams.get('redirect'), platformOrigin));
	},

	/** Use a one-time backup code when the authenticator app is unavailable. */
	verifyBackupCode: async ({ request, url }) => {
		const value = String((await request.formData()).get('code') ?? '').trim();
		if (!value) return fail(400, { message: 'Enter one of your backup codes.', step: 'backup' });
		try {
			await auth.api.verifyBackupCode({ body: { code: value }, headers: request.headers });
		} catch (error) {
			return fail(400, { message: authErrorMessage(error), step: 'backup' });
		}
		redirect(303, continueTo(url.searchParams.get('redirect'), platformOrigin));
	}
};

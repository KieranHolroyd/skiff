import { fail } from '@sveltejs/kit';
import { getAuthenticatorName } from '@better-auth/passkey';
import { auth } from '#lib/server/auth.js';
import {
	carrySecondFactorToToken,
	enforceOwnerSecondFactor,
	userHasPassword,
	userHasTotp
} from '#lib/server/second-factor.js';
import { passwordProblem } from '#lib/server/setup.js';
import { formPassword } from '#lib/server/totp-enrolment.js';
import {
	clearSessionStepUp,
	clearStepUpForUser,
	refreshStrongestStepUp,
} from '#lib/server/step-up.js';
import { freshUntil, isVerificationFresh, minutesLeft } from '#lib/server/step-up/policy.js';
import {
	authErrorMessage,
	providerLabel,
	toIso,
	toSessionSummaries
} from '#lib/server/user-settings.js';
import { formString } from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

const MAX_NAME = 80;

export const load: PageServerLoad = async ({ locals, request }) => {
	const user = locals.user!;
	const currentSessionId = locals.session?.id ?? null;

	let sessions: Awaited<ReturnType<typeof toSessionSummaries>> = [];
	let sessionsError: string | null = null;
	try {
		const listed = await auth.api.listSessions({ headers: request.headers });
		sessions = toSessionSummaries(listed, currentSessionId);
	} catch (error) {
		sessionsError = `Active sessions are temporarily unavailable: ${authErrorMessage(error)}`;
	}

	let accounts: Array<{
		id: string;
		provider: string;
		providerId: string;
		createdAt: string | null;
	}> = [];
	let accountsError: string | null = null;
	try {
		const listed = await auth.api.listUserAccounts({ headers: request.headers });
		// The password has its own card; this list is for external providers.
		accounts = listed.filter((account) => account.providerId !== 'credential').map((account) => ({
			id: account.id,
			provider: providerLabel(account.providerId),
			providerId: account.providerId,
			createdAt: toIso(account.createdAt)
		}));
	} catch (error) {
		accountsError = `Sign-in methods are temporarily unavailable: ${authErrorMessage(error)}`;
	}

	let passkeys: Array<{
		id: string;
		name: string;
		authenticator: string | null;
		deviceType: string;
		backedUp: boolean;
		createdAt: string | null;
	}> = [];
	let passkeysError: string | null = null;
	try {
		const listed = await auth.api.listPasskeys({ headers: request.headers });
		passkeys = listed
			.map((passkey) => ({
				id: passkey.id,
				name: passkey.name?.trim() || getAuthenticatorName(passkey.aaguid) || 'Passkey',
				authenticator: getAuthenticatorName(passkey.aaguid) ?? null,
				deviceType: passkey.deviceType,
				backedUp: passkey.backedUp,
				createdAt: toIso(passkey.createdAt)
			}))
			.sort(
				(a, b) =>
					(b.createdAt ? Date.parse(b.createdAt) : 0) - (a.createdAt ? Date.parse(a.createdAt) : 0)
			);
	} catch (error) {
		passkeysError = `Passkeys are temporarily unavailable: ${authErrorMessage(error)}`;
	}

	const verification = locals.principal!.verification;
	const stepUp = verification
		? {
				fresh: isVerificationFresh(verification),
				class: verification.class,
				strongest: verification.strongest,
				minutesLeft: minutesLeft(freshUntil(verification)),
			}
		: null;

	return {
		user: {
			id: user.id,
			name: user.name ?? '',
			email: user.email,
			emailVerified: user.emailVerified,
			createdAt: toIso(user.createdAt)
		},
		role: locals.principal!.role,
		currentSessionId,
		stepUp,
		sessions,
		sessionsError,
		accounts,
		accountsError,
		passkeys,
		passkeysError,
		hasPassword: userHasPassword(user.id),
		twoFactor: {
			totpEnabled: userHasTotp(user.id),
			/** How this session proved a second factor, if it did. */
			sessionFactor:
				(locals.session as { secondFactor?: string | null } | undefined)?.secondFactor ?? null,
			/** Owners must use a passkey or authenticator app (D10). */
			requiredForRole:
				enforceOwnerSecondFactor && locals.principal!.permissions.has('iam:manage-owners')
		}
	};
};

export const actions: Actions = {
	updateProfile: async ({ request }) => {
		const data = await request.formData();
		const name = formString(data, 'name');

		if (!name) {
			return fail(400, {
				message: 'Add a display name so teammates can recognise you.',
				fieldErrors: { name: 'A display name is required.' }
			});
		}
		if (name.length > MAX_NAME) {
			return fail(400, {
				message: `Keep your display name to ${MAX_NAME} characters or fewer.`,
				fieldErrors: { name: 'Too long.' }
			});
		}

		try {
			await auth.api.updateUser({ body: { name }, headers: request.headers });
		} catch (error) {
			return fail(400, { message: authErrorMessage(error) });
		}

		return { success: 'Profile updated.' };
	},

	revokeSession: async ({ request, locals }) => {
		const data = await request.formData();
		const sessionId = formString(data, 'sessionId');
		if (!sessionId) return fail(400, { message: 'Missing session id.' });
		if (sessionId === locals.session?.id) {
			return fail(400, { message: 'Use Sign out to end the session you are currently using.' });
		}

		try {
			const listed = await auth.api.listSessions({ headers: request.headers });
			const target = listed.find((session) => session.id === sessionId);
			if (!target) return fail(404, { message: 'That session has already ended.' });
			await auth.api.revokeSession({ body: { token: target.token }, headers: request.headers });
		} catch (error) {
			return fail(400, { message: authErrorMessage(error) });
		}

		return { success: 'Session revoked. That device has been signed out.' };
	},

	revokeOtherSessions: async ({ request }) => {
		try {
			await auth.api.revokeOtherSessions({ headers: request.headers });
		} catch (error) {
			return fail(400, { message: authErrorMessage(error) });
		}

		return { success: 'All other sessions have been signed out.' };
	},

	/** Add a password to an account that signs in with a passkey, GitHub or email link (D103). */
	setPassword: async ({ request, locals }) => {
		const data = await request.formData();
		const newPassword = String(data.get('newPassword') ?? '');
		const problem = passwordProblem(newPassword, String(data.get('confirmPassword') ?? ''));
		if (problem) return fail(400, { message: problem, fieldErrors: { newPassword: problem } });
		if (userHasPassword(locals.user!.id))
			return fail(400, { message: 'You already have a password. Change it instead.' });
		try {
			await auth.api.setPassword({ body: { newPassword }, headers: request.headers });
		} catch (error) {
			return fail(400, { message: authErrorMessage(error) });
		}
		return { success: 'Password set. You can now sign in with your email and password.' };
	},

	/** Change the password; every other session is signed out. */
	changePassword: async ({ request, locals }) => {
		const data = await request.formData();
		const currentPassword = String(data.get('currentPassword') ?? '');
		const newPassword = String(data.get('newPassword') ?? '');
		if (!currentPassword)
			return fail(400, { message: 'Enter your current password.', fieldErrors: { currentPassword: 'Required.' } });
		const problem = passwordProblem(newPassword, String(data.get('confirmPassword') ?? ''));
		if (problem) return fail(400, { message: problem, fieldErrors: { newPassword: problem } });
		const factor = (locals.session as { secondFactor?: string | null } | undefined)?.secondFactor;
		try {
			const result = await auth.api.changePassword({
				body: { currentPassword, newPassword, revokeOtherSessions: true },
				headers: request.headers
			});
			if (result.token && factor) carrySecondFactorToToken(result.token, factor);
			// A password change is a clearing event for step-up (STEP-UP.md §3). Better Auth may have
			// issued a fresh session for this device, so clear that one explicitly too.
			clearStepUpForUser(locals.user!.id);
			if (locals.session?.id) clearSessionStepUp(locals.session.id);
		} catch (error) {
			return fail(400, { message: authErrorMessage(error), fieldErrors: { currentPassword: 'Check this.' } });
		}
		return { success: 'Password changed. Other devices were signed out.' };
	},

	disableTotp: async ({ request, locals }) => {
		const user = locals.user!;
		if (!userHasTotp(user.id)) return fail(400, { message: 'No authenticator app is set up.' });
		const password = formPassword(await request.formData());
		try {
			await auth.api.disableTwoFactor({ body: password ? { password } : {}, headers: request.headers });
			// Removing any factor clears every step-up window (STEP-UP.md §3), and `strongest` may
			// drop from strong to basic.
			clearStepUpForUser(user.id);
			refreshStrongestStepUp(user.id);
		} catch (error) {
			return fail(400, { message: authErrorMessage(error) });
		}
		return { success: 'Authenticator app removed.' };
	},

	deletePasskey: async ({ request, locals }) => {
		const data = await request.formData();
		const id = formString(data, 'passkeyId');
		if (!id) return fail(400, { message: 'Missing passkey id.' });

		try {
			await auth.api.deletePasskey({ body: { id }, headers: request.headers });
			clearStepUpForUser(locals.user!.id);
			refreshStrongestStepUp(locals.user!.id);
		} catch (error) {
			return fail(400, { message: authErrorMessage(error) });
		}

		return { success: 'Passkey removed.' };
	},

	/** "Lock now" from Settings → Account: clear this session's window without signing out. */
	lockStepUp: async ({ locals }) => {
		if (locals.session?.id) clearSessionStepUp(locals.session.id);
		return { success: 'Locked. Sensitive actions will ask you to verify again.' };
	}
};

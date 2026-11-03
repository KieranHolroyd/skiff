import { fail } from '@sveltejs/kit';
import { getAuthenticatorName } from '@better-auth/passkey';
import { auth } from '#lib/server/auth.js';
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
		accounts = listed.map((account) => ({
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
		sessions,
		sessionsError,
		accounts,
		accountsError,
		passkeys,
		passkeysError
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

	deletePasskey: async ({ request }) => {
		const data = await request.formData();
		const id = formString(data, 'passkeyId');
		if (!id) return fail(400, { message: 'Missing passkey id.' });

		try {
			await auth.api.deletePasskey({ body: { id }, headers: request.headers });
		} catch (error) {
			return fail(400, { message: authErrorMessage(error) });
		}

		return { success: 'Passkey removed.' };
	}
};

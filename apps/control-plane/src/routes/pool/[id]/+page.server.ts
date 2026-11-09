import { fail, redirect } from '@sveltejs/kit';
import { CoreError } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { clientKey, poolSessionToken, validCsrf } from '../_lib/hosted.js';
import type { Actions, PageServerLoad } from './$types';

/** A small landing page for a signed-in pool visitor; the real destinations are the client app. */
export const load: PageServerLoad = ({ params, cookies }) => {
	const session = core.userPoolEngine.session(params.id, poolSessionToken(cookies, params.id));
	if (!session) redirect(303, `/pool/${params.id}/login`);
	return {
		user: session.user,
		passkeys: core.userPoolEngine.listPasskeys(params.id, session.user.id),
		totp: core.userPoolEngine.totpStatus(params.id, session.user.id),
		groups: core.userPoolEngine.groupsForUser(params.id, session.user.id)
	};
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
	},

	/** Remove one enrolled passkey. The password and any other passkeys keep working. */
	removePasskey: async (event) => {
		const { params, request, cookies } = event;
		const session = core.userPoolEngine.session(params.id, poolSessionToken(cookies, params.id));
		if (!session) redirect(303, `/pool/${params.id}/login`);
		const form = await request.formData();
		if (!validCsrf(cookies, params.id, form.get('csrf')))
			return fail(400, { error: 'Your form expired. Reload the page and try again.' });
		const passkeyId = String(form.get('passkey_id') ?? '');
		if (!passkeyId) return fail(400, { error: 'Choose a passkey to remove.' });
		if (!core.userPoolEngine.deletePasskey(params.id, session.user.id, passkeyId))
			return fail(404, { error: 'That passkey is no longer registered.' });
		return { removed: true };
	},

	/** Start TOTP enrolment; the secret and otpauth URI are returned once for this page render. */
	beginTotp: async (event) => {
		const { params, request, cookies } = event;
		const session = core.userPoolEngine.session(params.id, poolSessionToken(cookies, params.id));
		if (!session) redirect(303, `/pool/${params.id}/login`);
		const form = await request.formData();
		if (!validCsrf(cookies, params.id, form.get('csrf')))
			return fail(400, { error: 'Your form expired. Reload the page and try again.' });
		try {
			return {
				totpEnrolment: core.userPoolEngine.totpEnrol(params.id, session.user.id)
			};
		} catch (cause) {
			if (cause instanceof CoreError) return fail(cause.status, { error: cause.message });
			throw cause;
		}
	},

	/** Confirm the first code; the recovery codes are shown exactly once in this response. */
	confirmTotp: async (event) => {
		const { params, request, cookies } = event;
		const session = core.userPoolEngine.session(params.id, poolSessionToken(cookies, params.id));
		if (!session) redirect(303, `/pool/${params.id}/login`);
		const form = await request.formData();
		if (!validCsrf(cookies, params.id, form.get('csrf')))
			return fail(400, { error: 'Your form expired. Reload the page and try again.' });
		const code = String(form.get('code') ?? '');
		try {
			return core.userPoolEngine.totpConfirm(params.id, session.user.id, code);
		} catch (cause) {
			if (cause instanceof CoreError) return fail(cause.status, { error: cause.message });
			throw cause;
		}
	},

	disableTotp: async (event) => {
		const { params, request, cookies } = event;
		const session = core.userPoolEngine.session(params.id, poolSessionToken(cookies, params.id));
		if (!session) redirect(303, `/pool/${params.id}/login`);
		const form = await request.formData();
		if (!validCsrf(cookies, params.id, form.get('csrf')))
			return fail(400, { error: 'Your form expired. Reload the page and try again.' });
		const code = String(form.get('code') ?? '');
		try {
			core.userPoolEngine.totpDisable(params.id, session.user.id, code);
			return { totpDisabled: true };
		} catch (cause) {
			if (cause instanceof CoreError) return fail(cause.status, { error: cause.message });
			throw cause;
		}
	},

	regenerateRecoveryCodes: async (event) => {
		const { params, request, cookies } = event;
		const session = core.userPoolEngine.session(params.id, poolSessionToken(cookies, params.id));
		if (!session) redirect(303, `/pool/${params.id}/login`);
		const form = await request.formData();
		if (!validCsrf(cookies, params.id, form.get('csrf')))
			return fail(400, { error: 'Your form expired. Reload the page and try again.' });
		const code = String(form.get('code') ?? '');
		try {
			return core.userPoolEngine.regenerateRecoveryCodes(params.id, session.user.id, code);
		} catch (cause) {
			if (cause instanceof CoreError) return fail(cause.status, { error: cause.message });
			throw cause;
		}
	}
};

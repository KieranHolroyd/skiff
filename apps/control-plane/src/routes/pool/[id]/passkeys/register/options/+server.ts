import { json } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import { allowAttempt, clientKey, poolSessionToken, validCsrf } from '../../../../_lib/hosted.js';
import { apiError, bodyString, NO_STORE, readBody } from '../../_shared.js';
import type { RequestHandler } from './$types';

/**
 * Registration options for the signed-in pool visitor. The challenge is stored server-side and
 * bound to this pool and user; the page gets an opaque `challengeId` back.
 */
export const POST: RequestHandler = async (event) => {
	const { params, cookies, request } = event;
	const session = core.userPoolEngine.session(params.id, poolSessionToken(cookies, params.id));
	if (!session)
		return json({ error: 'Your session expired. Sign in again.' }, { status: 401, headers: NO_STORE });

	const body = await readBody(request);
	if (!validCsrf(cookies, params.id, bodyString(body, 'csrf')))
		return json(
			{ error: 'Your form expired. Reload the page and try again.' },
			{ status: 400, headers: NO_STORE }
		);
	if (!allowAttempt(`passkey-register-options:${params.id}:${clientKey(event)}`))
		return json(
			{ error: 'Too many passkey attempts. Wait a minute and try again.' },
			{ status: 429, headers: NO_STORE }
		);

	try {
		const issued = await core.userPoolEngine.passkeyRegisterOptions(
			params.id,
			session.user.id,
			event.url.origin
		);
		return json(issued, { headers: NO_STORE });
	} catch (error) {
		return apiError(error);
	}
};

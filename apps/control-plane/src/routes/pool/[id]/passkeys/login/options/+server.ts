import { json } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import { allowAttempt, clientKey, validCsrf } from '../../../../_lib/hosted.js';
import { apiError, bodyString, NO_STORE, readBody } from '../../_shared.js';
import type { RequestHandler } from './$types';

/**
 * Start a passkey sign-in. No session is required and the answer is identical for a known and an
 * unknown address: the options are discoverable and never list this address's credentials.
 */
export const POST: RequestHandler = async (event) => {
	const { params, cookies, request } = event;
	const body = await readBody(request);
	if (!validCsrf(cookies, params.id, bodyString(body, 'csrf')))
		return json(
			{ error: 'Your sign-in form expired. Reload the page and try again.' },
			{ status: 400, headers: NO_STORE }
		);
	if (!allowAttempt(`passkey-login-options:${params.id}:${clientKey(event)}`))
		return json(
			{ error: 'Too many passkey attempts. Wait a minute and try again.' },
			{ status: 429, headers: NO_STORE }
		);

	try {
		const issued = await core.userPoolEngine.passkeyLoginOptions(
			params.id,
			bodyString(body, 'email'),
			{ origin: event.url.origin }
		);
		return json(issued, { headers: NO_STORE });
	} catch (error) {
		return apiError(error);
	}
};

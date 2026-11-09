import { json } from '@sveltejs/kit';
import type { UserPoolPasskeyAuthenticationResponse } from '@skiff/core';
import { safeRedirect } from '#lib/redirect.js';
import { platformOrigin } from '#lib/server/config.js';
import { core } from '#lib/server/core.js';
import {
	allowAttempt,
	clientKey,
	setPoolSession,
	validCsrf
} from '../../../../_lib/hosted.js';
import { apiError, bodyString, NO_STORE, readBody } from '../../_shared.js';
import type { RequestHandler } from './$types';

/**
 * Finish a passkey sign-in and start a pool session. Every refusal is the engine's generic
 * message, so a caller cannot tell an unknown credential from a bad signature or a cloned one.
 */
export const POST: RequestHandler = async (event) => {
	const { params, cookies, request } = event;
	const body = await readBody(request);
	if (!validCsrf(cookies, params.id, bodyString(body, 'csrf')))
		return json(
			{ error: 'Your sign-in form expired. Reload the page and try again.' },
			{ status: 400, headers: NO_STORE }
		);
	if (!allowAttempt(`passkey-login-verify:${params.id}:${clientKey(event)}`))
		return json(
			{ error: 'Too many passkey attempts. Wait a minute and try again.' },
			{ status: 429, headers: NO_STORE }
		);

	const challengeId = bodyString(body, 'challengeId');
	const response = body.response;
	if (!challengeId || !response || typeof response !== 'object')
		return json({ error: 'Passkey sign-in failed.' }, { status: 401, headers: NO_STORE });

	try {
		const signedIn = await core.userPoolEngine.passkeyLoginVerify({
			poolId: params.id,
			challengeId,
			response: response as unknown as UserPoolPasskeyAuthenticationResponse,
			email: bodyString(body, 'email'),
			ip: clientKey(event)
		});
		setPoolSession(cookies, params.id, signedIn.token);
		return json(
			{
				redirect: safeRedirect(
					bodyString(body, 'return_to'),
					platformOrigin,
					`/pool/${params.id}`
				)
			},
			{ headers: NO_STORE }
		);
	} catch (error) {
		return apiError(error);
	}
};

import { json } from '@sveltejs/kit';
import type { UserPoolPasskeyRegistrationResponse } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { allowAttempt, clientKey, poolSessionToken, validCsrf } from '../../../../_lib/hosted.js';
import { apiError, bodyString, NO_STORE, readBody } from '../../_shared.js';
import type { RequestHandler } from './$types';

/** Finish passkey enrolment. The challenge id is single use and bound to this pool and user. */
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
	if (!allowAttempt(`passkey-register-verify:${params.id}:${clientKey(event)}`))
		return json(
			{ error: 'Too many passkey attempts. Wait a minute and try again.' },
			{ status: 429, headers: NO_STORE }
		);

	const challengeId = bodyString(body, 'challengeId');
	const response = body.response;
	if (!challengeId || !response || typeof response !== 'object')
		return json({ error: 'That passkey could not be registered. Try again.' }, { status: 400, headers: NO_STORE });

	try {
		const passkey = await core.userPoolEngine.passkeyRegisterVerify({
			poolId: params.id,
			userId: session.user.id,
			challengeId,
			response: response as unknown as UserPoolPasskeyRegistrationResponse,
			name: bodyString(body, 'name')
		});
		return json({ passkey }, { headers: NO_STORE });
	} catch (error) {
		return apiError(error);
	}
};

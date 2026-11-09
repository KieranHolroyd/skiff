import type { RequestHandler } from './$types';
import { userPoolSessionCookieName } from '@skiff/core';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';

/**
 * OIDC authorization endpoint for one pool (IAM.md §11.2).
 *
 * The code flow is browser-facing: a signed-in pool session gets a single-use code in a redirect
 * to the client's registered callback; anyone else is sent to the pool's own hosted login page
 * with `return_to` pointing back here. The platform session is never consulted.
 */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const params = event.url.searchParams;
		const poolId = event.params.id;
		const result = await core.userPoolEngine.authorize({
			poolId,
			clientId: params.get('client_id') ?? '',
			redirectUri: params.get('redirect_uri') ?? '',
			responseType: params.get('response_type') ?? '',
			scope: params.get('scope'),
			state: params.get('state'),
			nonce: params.get('nonce'),
			codeChallenge: params.get('code_challenge'),
			codeChallengeMethod: params.get('code_challenge_method'),
			sessionToken: event.cookies.get(userPoolSessionCookieName(poolId)),
			requestUrl: event.url.toString()
		});
		return new Response(null, {
			status: 303,
			headers: { location: result.redirect, 'cache-control': 'no-store' }
		});
	});

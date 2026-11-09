import type { RequestHandler } from './$types';
import { USER_POOL_SESSION_TTL_SECONDS, userPoolSessionCookieName } from '@skiff/core';
import { core } from '#lib/server/core.js';
import { platformOrigin } from '#lib/server/config.js';

/**
 * Social-login callback for one pool (IAM.md §11.2).
 *
 * The provider redirects here with `code` and `state`. The engine consumes the server-side state
 * and PKCE verifier, exchanges the code, links or creates a pool user by its verified email, and
 * returns a normal pool session. Failures are deliberately opaque: the browser is sent back to the
 * hosted login page with `?oauth=error`, never with a provider message or a token.
 */
export const GET: RequestHandler = async (event) => {
	const poolId = event.params.id;
	const provider = event.params.provider;
	const failure = loginRedirect(poolId);
	if (event.url.searchParams.get('error')) return redirect(failure);

	const code = event.url.searchParams.get('code');
	const state = event.url.searchParams.get('state');
	if (!code || !state) return redirect(failure);

	try {
		const result = await core.userPoolEngine.oauthCallback(poolId, provider, code, state);
		event.cookies.set(userPoolSessionCookieName(poolId), result.token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: platformOrigin.startsWith('https://'),
			maxAge: USER_POOL_SESSION_TTL_SECONDS
		});
		return redirect(result.returnTo ?? `/pool/${encodeURIComponent(poolId)}`);
	} catch {
		return redirect(failure);
	}
};

function loginRedirect(poolId: string): string {
	return `/pool/${encodeURIComponent(poolId)}/login?oauth=error`;
}

function redirect(location: string): Response {
	return new Response(null, {
		status: 303,
		headers: { location, 'cache-control': 'no-store' }
	});
}

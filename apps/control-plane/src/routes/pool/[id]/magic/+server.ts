import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { platformOrigin } from '#lib/server/config.js';
import { safeRedirect } from '#lib/redirect.js';
import { setPoolSession } from '../../_lib/hosted.js';

/**
 * Consume a magic sign-in link. The token is single use and short lived; a successful click both
 * proves the address (it is marked verified) and starts a pool session. A failure always sends the
 * browser back to the sign-in page with one generic notice.
 */
export const GET: RequestHandler = async (event) => {
	const token = event.url.searchParams.get('token') ?? '';
	const returnTo = event.url.searchParams.get('return_to');
	let signedIn: Awaited<ReturnType<typeof core.userPoolEngine.magicLinkSignIn>>;
	try {
		signedIn = await core.userPoolEngine.magicLinkSignIn(event.params.id, token);
	} catch {
		return redirect(`/pool/${event.params.id}/login?magic=invalid`);
	}
	setPoolSession(event.cookies, event.params.id, signedIn.token);
	return redirect(safeRedirect(returnTo, platformOrigin, `/pool/${event.params.id}`));
};

function redirect(location: string): Response {
	return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

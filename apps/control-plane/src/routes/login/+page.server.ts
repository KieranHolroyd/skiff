import { devPasswordLogin, platformOrigin } from '#lib/server/config.js';
import { safeRedirect } from '#lib/redirect.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	// Only destinations on the platform origin are accepted (open-redirect guard); the page uses
	// this value for every sign-in method, so validating it here covers the client too.
	const redirect = safeRedirect(url.searchParams.get('redirect'), platformOrigin);
	return { devPasswordLogin, redirect };
};

import { redirect } from '@sveltejs/kit';
import { openSignup, platformOrigin, smtp } from '#lib/server/config.js';
import { githubSignIn, gitlabSignIn } from '#lib/server/auth.js';
import { sqlite } from '#lib/server/db.js';
import { needsSetup } from '#lib/server/setup.js';
import { safeRedirect } from '#lib/redirect.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	// A fresh install has nobody to sign in as: the owner is created by the setup wizard (D102).
	// Open-signup dev servers keep signing up through this page.
	if (!openSignup && needsSetup(sqlite)) redirect(303, '/setup');
	// Only destinations on the platform origin are accepted (open-redirect guard); the page uses
	// this value for every sign-in method, so validating it here covers the client too.
	const redirectTo = safeRedirect(url.searchParams.get('redirect'), platformOrigin);
	return {
		redirect: redirectTo,
		github: githubSignIn,
		gitlab: gitlabSignIn,
		/** Without SMTP, magic links go to the server log (ConsoleEmailTransport). */
		emailToLog: !smtp
	};
};

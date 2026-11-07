import { smtp } from '#lib/server/config.js';
import { PASSWORD_RESET_TTL_SECONDS } from '#lib/server/password-reset.js';
import type { PageServerLoad } from './$types';

/**
 * Ask for a password reset link (auth.ts `sendResetPassword`). Public. The page answers the same
 * for every address, so it never tells whether one has an account. Without SMTP there is no way to
 * deliver a link, so the page says an operator has to reset the password instead.
 */
export const load: PageServerLoad = ({ setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store' });
	return {
		emailConfigured: Boolean(smtp),
		ttlMinutes: PASSWORD_RESET_TTL_SECONDS / 60
	};
};

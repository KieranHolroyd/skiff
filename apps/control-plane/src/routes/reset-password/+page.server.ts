import { PASSWORD_RESET_TTL_SECONDS } from '#lib/server/password-reset.js';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '#lib/server/setup.js';
import type { PageServerLoad } from './$types';

/**
 * Choose a new password. Better Auth's `/api/auth/reset-password/:token` checks the emailed link
 * and sends the browser here with `?token=…`, or with `?error=INVALID_TOKEN` when the link has
 * expired or was used. The form posts the token to `/api/auth/reset-password`, which checks it
 * again (single use), sets the password and signs out every session.
 */
export const load: PageServerLoad = ({ url, setHeaders }) => {
	// The token is a credential: keep it out of caches and other sites' Referer headers.
	setHeaders({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
	const token = url.searchParams.get('token') ?? '';
	const invalid =
		url.searchParams.get('error') === 'INVALID_TOKEN' || !/^[A-Za-z0-9_-]{8,128}$/.test(token);
	return {
		token: invalid ? '' : token,
		invalid,
		minLength: MIN_PASSWORD_LENGTH,
		maxLength: MAX_PASSWORD_LENGTH,
		ttlMinutes: PASSWORD_RESET_TTL_SECONDS / 60
	};
};

import { error } from '@sveltejs/kit';
import { CoreError, randomToken, userPoolCsrfCookieName } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { platformOrigin } from '#lib/server/config.js';
import type { LayoutServerLoad } from './$types';

/**
 * The theme every hosted pool page shares. A short-lived double-submit CSRF token is set here so
 * the login, sign-up and logout forms can prove the request came from their own page. Nothing on
 * these pages reads or writes the platform session.
 */
export const load: LayoutServerLoad = ({ params, cookies, url }) => {
	let pool: ReturnType<typeof core.userPools.publicInfo>;
	try {
		pool = core.userPools.publicInfo(params.id);
	} catch (cause) {
		if (cause instanceof CoreError && cause.status === 404) error(404, 'User pool not found');
		throw cause;
	}
	const csrf = randomToken(24);
	cookies.set(userPoolCsrfCookieName(pool.id), csrf, {
		path: `/pool/${pool.id}`,
		httpOnly: true,
		sameSite: 'lax',
		secure: platformOrigin.startsWith('https://'),
		maxAge: 15 * 60
	});
	return {
		pool,
		csrf,
		returnTo: url.searchParams.get('return_to')
	};
};

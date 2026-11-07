import { fail } from '@sveltejs/kit';
import { CoreError } from '@skiff/core';
import { core } from '#lib/server/core.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * The link in a sandbox verification mail (docs/EMAIL.md §4.3). Public: the token is the credential.
 * Loading the page never uses the token up, so mail scanners that fetch links can't confirm an
 * address on its owner's behalf; only the button's POST does.
 */

export const load: PageServerLoad = ({ url, setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
	const token = url.searchParams.get('token') ?? '';
	const link = token ? core.email.peekSandboxVerification(token) : null;
	return { token, link };
};

export const actions: Actions = {
	default: async ({ request }) => {
		const value = (await request.formData()).get('token');
		const token = typeof value === 'string' ? value : '';
		try {
			const verified = core.email.verifySandboxAddress(token);
			return { verified };
		} catch (caught) {
			if (caught instanceof CoreError) return fail(caught.status === 410 ? 410 : 404, { message: caught.message });
			throw caught;
		}
	}
};

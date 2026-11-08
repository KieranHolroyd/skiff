import { redirect } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import type { PageServerLoad } from './$types';

/**
 * GitHub's manifest flow returns here with `?code&state` (docs/GITHUB.md). The code is exchanged
 * for the new App's credentials once, then the admin lands back on Settings → GitHub.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	if (!code || !state) return { error: 'GitHub did not send the App back. Start again from Settings → GitHub.' };
	let failure: string | null = null;
	try {
		await core.githubApp.completeManifest(locals.principal!, code, state);
	} catch (cause) {
		failure = cause instanceof Error ? cause.message : String(cause);
	}
	if (failure) return { error: failure };
	redirect(303, '/settings/github?created=1');
};

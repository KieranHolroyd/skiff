import { redirect } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import type { PageServerLoad } from './$types';

/**
 * Where GitHub sends someone who installed (or changed) the App: `?installation_id`,
 * `setup_action`, an OAuth `code` and our `state` (docs/GITHUB.md). GitHub confirms through the
 * user's own token that they can see the installation before it is linked to this org.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	const installationId = Number(url.searchParams.get('installation_id'));
	if (!Number.isInteger(installationId) || installationId <= 0) {
		// An OAuth round-trip without an installation (for example "Authorize" from GitHub's App page).
		redirect(303, '/settings/github');
	}
	let linked: string | null = null;
	let failure: string | null = null;
	try {
		const view = await core.githubApp.completeInstallation(locals.principal!, {
			installationId,
			code: url.searchParams.get('code'),
			state: url.searchParams.get('state'),
			setupAction: url.searchParams.get('setup_action')
		});
		linked = view.account.login;
	} catch (cause) {
		failure = cause instanceof Error ? cause.message : String(cause);
	}
	if (failure) return { error: failure, installationId };
	redirect(303, `/settings/github?linked=${encodeURIComponent(linked ?? '')}`);
};

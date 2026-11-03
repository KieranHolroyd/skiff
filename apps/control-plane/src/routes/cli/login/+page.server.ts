import { error, redirect } from '@sveltejs/kit';
import {
	cliLoginCallbackUrl,
	createCliLoginCode,
	parseCliLoginRequest
} from '#lib/server/cli-login.js';
import type { Actions, PageServerLoad } from './$types';

const FIELDS = ['redirect_uri', 'state', 'code_challenge', 'code_challenge_method'] as const;

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user)
		redirect(303, `/login?redirect=${encodeURIComponent(`${url.pathname}${url.search}`)}`);

	const parsed = parseCliLoginRequest(url.searchParams);
	if (!parsed.ok) error(400, parsed.message);
	if (!locals.principal?.permissions.has('apiKey:create'))
		error(403, 'Your role cannot create API keys, so it cannot sign in the CLI. Ask an org owner or admin.');

	return {
		...parsed.request,
		email: locals.user.email ?? null,
		name: locals.user.name ?? null,
		role: locals.principal?.role ?? null
	};
};

export const actions = {
	default: async ({ locals, request }) => {
		if (!locals.user) error(401, 'Sign in to authorize the CLI.');
		if (!locals.principal?.permissions.has('apiKey:create'))
			error(403, 'Your role cannot create API keys, so it cannot sign in the CLI.');

		const form = await request.formData();
		const params = new URLSearchParams();
		for (const field of FIELDS) {
			const value = form.get(field);
			if (typeof value === 'string') params.set(field, value);
		}

		const parsed = parseCliLoginRequest(params);
		if (!parsed.ok) error(400, parsed.message);

		if (form.get('decision') !== 'approve') {
			redirect(
				303,
				cliLoginCallbackUrl(parsed.request.redirectUri, {
					error: 'access_denied',
					state: parsed.request.state
				}),
				{ external: true }
			);
		}

		const code = createCliLoginCode({
			userId: locals.user.id,
			redirectUri: parsed.request.redirectUri,
			codeChallenge: parsed.request.codeChallenge
		});
		redirect(
			303,
			cliLoginCallbackUrl(parsed.request.redirectUri, {
				code,
				state: parsed.request.state
			}),
			{ external: true }
		);
	}
} satisfies Actions;

import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';

/**
 * Consume an email-verification link. This is a side-effecting GET because the link comes from a
 * mail, matching the platform's own verification link; it never signs anybody in.
 */
export const GET: RequestHandler = (event) => {
	const token = event.url.searchParams.get('token') ?? '';
	const location = `/pool/${event.params.id}/login`;
	try {
		core.userPoolEngine.verifyEmail(event.params.id, token);
		return redirect(`${location}?verified=1`);
	} catch {
		return redirect(`${location}?verify=invalid`);
	}
};

function redirect(location: string): Response {
	return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

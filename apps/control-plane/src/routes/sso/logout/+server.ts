import type { RequestHandler } from './$types';
import { auth } from '#lib/server/auth.js';
import { core } from '#lib/server/core.js';
import { sso, type SsoLogoutTarget } from '#lib/server/sso.js';

/**
 * Sign out of Skiff, then send the browser to the IdP's Single Logout Service when it is configured.
 *
 * `@better-auth/sso` has full SAML SLO endpoints (`/api/auth/sso/saml2/logout/:providerId` and the
 * IdP callback `/api/auth/sso/saml2/sp/slo/:providerId`), but they are only registered when its
 * `saml.enableSingleLogout` option is on. That option is set where the plugin is constructed
 * (`auth.ts`), which is outside this slice. The derived `samlConfig` already carries
 * `idpMetadata.singleLogoutService`, so enabling the plugin's endpoints later needs no data change.
 *
 * Until then this route does the safe local half: Better Auth deletes the session and clears its
 * cookie, and an `slo_url` configured on the provider becomes the redirect target. It deliberately
 * does not fabricate a SAML `LogoutRequest`, which would need SP request signing (deferred because
 * the plugin requires a stored SP private key) and would be rejected by most IdPs unsigned.
 */
export const GET: RequestHandler = (event) => logout(event);
export const POST: RequestHandler = (event) => logout(event);

function sameOrigin(value: string, requestUrl: URL): boolean {
	try {
		return new URL(value, requestUrl).origin === requestUrl.origin;
	} catch {
		return false;
	}
}

async function logout(event: Parameters<RequestHandler>[0]): Promise<Response> {
	const requestUrl = new URL(event.request.url);
	let providerId = requestUrl.searchParams.get('providerId')?.trim() || undefined;
	let returnTo =
		requestUrl.searchParams.get('returnTo') ??
		requestUrl.searchParams.get('post_logout_redirect_uri') ??
		'/login';

	if (event.request.method === 'POST') {
		try {
			const form = await event.request.formData();
			providerId = String(form.get('providerId') ?? '').trim() || providerId;
			const postedReturn = String(form.get('returnTo') ?? '').trim();
			if (postedReturn) returnTo = postedReturn;
		} catch {
			// A non-form POST still signs out; only the optional target is lost.
		}
	}

	// `asResponse` gives the Set-Cookie headers that expire Better Auth's session cookies.
	let signedOut: Response;
	try {
		signedOut = await auth.api.signOut({
			headers: event.request.headers,
			asResponse: true
		});
	} catch {
		signedOut = new Response(null, { status: 200 });
	}

	const principal = event.locals.principal;
	const target: SsoLogoutTarget = principal
		? sso.resolveLogoutTarget(principal, providerId)
		: { providerId: providerId ?? null, sloUrl: null, sloBinding: 'redirect' };
	const fallback = sameOrigin(returnTo, requestUrl) ? new URL(returnTo, requestUrl).toString() : '/login';
	const location = target.sloUrl ?? fallback;

	if (principal) {
		try {
			core.ctx.audit.record({
				principal,
				action: 'sso.logout',
				resource: 'sso',
				resourceId: target.providerId ?? principal.userId,
				args: { sloUrl: target.sloUrl, sloBinding: target.sloBinding, idpInitiated: false },
				result: 'ok'
			});
		} catch {
			// Signing out must not depend on the audit table being writable.
		}
	}

	const headers = new Headers(signedOut.headers);
	headers.delete('content-type');
	headers.delete('content-length');
	headers.set('location', location);
	headers.set('cache-control', 'no-store');
	return new Response(null, { status: 303, headers });
}

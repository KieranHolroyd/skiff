import { building } from '$app/env';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { getMigrations } from 'better-auth/db/migration';
import type { RequestEvent } from '@sveltejs/kit';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { auth, backfillApiKeyRateLimits, ensurePlatformAdmin } from '#lib/server/auth.js';
import { platformOrigin } from '#lib/server/config.js';
import { checkCsrf } from '#lib/server/csrf.js';
import { core } from '#lib/server/core.js';
import { isDevContentHost, serveDevContent } from '#lib/server/dev-content.js';
import { principalFromRequest, principalFromSession } from '#lib/server/principal.js';
import { enforceOwnerSecondFactor, userHasSecondFactor } from '#lib/server/second-factor.js';
import { isExemptBeforeSecondFactor, secondFactorState } from '#lib/server/second-factor-policy.js';

/**
 * Apply Better Auth's schema on boot.
 * TODO(release): replace with forward-only Drizzle migrations run by the updater after a
 * SQLite snapshot (DESIGN §12); auto-migrate is only acceptable during the build phase.
 */
export const init: ServerInit = async () => {
	if (building) return;
	const { runMigrations } = await getMigrations(auth.options);
	await runMigrations();
	const lifted = backfillApiKeyRateLimits();
	if (lifted > 0) console.info(`[auth] raised rate limit on ${lifted} API key(s)`);
	const promoted = ensurePlatformAdmin();
	if (promoted) console.info(`[auth] made the bootstrap user ${promoted} the platform admin`);

	// A standby (zero-downtime update slot, or the updater's canary) serves requests only. The
	// primary keeps owning background work, so nothing runs twice while both are up.
	if (process.env.SKIFF_STANDBY === '1') {
		console.info('[standby] serving requests only; background work stays with the primary');
		return;
	}

	// One maintenance loop per process (HMR can call init more than once).
	const global = globalThis as typeof globalThis & { __skiffMaintenance?: ReturnType<typeof setInterval> };
	if (!global.__skiffMaintenance) {
		global.__skiffMaintenance = setInterval(() => {
			void core.maintenance.run().catch((error) => console.error('[maintenance]', error));
		}, 60_000);
		global.__skiffMaintenance.unref?.();
		// Pick up mass operations whose runner died with the previous process (docs/OPERATIONS.md §2.2).
		setTimeout(() => {
			try {
				const resumed = core.operations.resume();
				if (resumed.length) console.info(`[operations] resumed ${resumed.length} operation(s)`);
			} catch (error) {
				console.error('[operations] resume failed:', error);
			}
		}, 65_000).unref?.();
	}
};

export const handle: Handle = async ({ event, resolve }) => {
	// Dev server only: serve `<slug>.localhost` content hosts straight from the local object store
	// instead of requiring the agent + Caddy. Production never reaches this branch.
	if (isDevContentHost(event.url.hostname)) return serveDevContent(event);

	const csrf = checkCsrf(event.request, event.url, platformOrigin);
	if (!csrf.ok) return new Response(`Forbidden: ${csrf.reason}`, { status: 403 });

	const session = await auth.api.getSession({ headers: event.request.headers });
	event.locals.user = session?.user;
	event.locals.session = session?.session;
	if (session?.user) {
		event.locals.principal = principalFromSession(session.user.id, event.request, {
			name: session.user.name ?? undefined,
		});
	} else if (event.request.headers.get('authorization')) {
		event.locals.principal = await principalFromRequest(event.request);
	}

	// The REST API is bearer/session authenticated throughout; answer 401 here, as JSON, so no handler
	// can turn a missing principal into a 500 (a `Response` thrown outside `route()` would).
	if (!event.locals.principal && isAuthenticatedApi(event.url.pathname))
		return withFrameProtection(Response.json({ error: 'unauthorized', message: 'Sign in or send a valid API key.' }, { status: 401 }));

	// Owner second factor (D10, second-factor-policy.ts): an owner's session must have proved a
	// passkey or authenticator code before it can reach anything beyond the challenge page.
	if (session && event.locals.principal && !isExemptBeforeSecondFactor(event.url.pathname)) {
		const state = secondFactorState({
			enforce: enforceOwnerSecondFactor,
			role: event.locals.principal.role,
			kind: event.locals.principal.kind,
			sessionFactor: (session.session as { secondFactor?: string | null }).secondFactor,
			hasFactor: event.locals.principal.role === 'owner' && userHasSecondFactor(session.user.id),
		});
		if (state !== 'satisfied') return withFrameProtection(secondFactorRequired(event));
	}

	const response = await svelteKitHandler({ event, resolve, auth, building });
	return withFrameProtection(response);
};

/** `/api/v1/**` except the endpoints that authenticate themselves (CLI code exchange). */
function isAuthenticatedApi(pathname: string): boolean {
	if (pathname === '/api/v1') return true;
	return pathname.startsWith('/api/v1/') && pathname !== '/api/v1/cli/token';
}

/** Pages redirect to the challenge (and back afterwards); API calls get a JSON 403. */
function secondFactorRequired(event: RequestEvent): Response {
	const { request, url } = event;
	const isRead = request.method === 'GET' || request.method === 'HEAD';
	// SvelteKit has already stripped `/__data.json` from `url` for client-side navigation requests.
	const location = `/two-factor?redirect=${encodeURIComponent(`${url.pathname}${event.isDataRequest ? '' : url.search}`)}`;
	// Client-side navigation follows a redirect given in SvelteKit's own data format.
	if (isRead && event.isDataRequest)
		return Response.json({ type: 'redirect', location }, { headers: { 'cache-control': 'no-store' } });
	if (isRead && (request.headers.get('accept') ?? '').includes('text/html'))
		return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
	return Response.json(
		{
			error: 'second_factor_required',
			message: 'Owners must verify a passkey or authenticator app first. Open /two-factor in the dashboard.',
		},
		{ status: 403 },
	);
}

/**
 * Nothing on the platform origin is meant to be framed. This stops clickjacking of the consent and
 * CLI-approval pages (an attacker-registered client could otherwise frame a pre-ticked consent).
 */
function withFrameProtection(response: Response): Response {
	try {
		response.headers.set('x-frame-options', 'DENY');
		const csp = response.headers.get('content-security-policy');
		if (!csp?.includes('frame-ancestors'))
			response.headers.set('content-security-policy', csp ? `${csp}; frame-ancestors 'none'` : "frame-ancestors 'none'");
		return response;
	} catch {
		// Immutable headers (e.g. a proxied fetch response): copy once so the headers can be set.
		const copy = new Response(response.body, response);
		copy.headers.set('x-frame-options', 'DENY');
		if (!copy.headers.get('content-security-policy')?.includes('frame-ancestors'))
			copy.headers.append('content-security-policy', "frame-ancestors 'none'");
		return copy;
	}
}

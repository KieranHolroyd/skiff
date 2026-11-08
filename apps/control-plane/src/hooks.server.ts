import { building } from '$app/env';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { getMigrations } from 'better-auth/db/migration';
import type { RequestEvent } from '@sveltejs/kit';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { auth, backfillApiKeyRateLimits, ensurePlatformAdmin } from '#lib/server/auth.js';
import { contentDomain, platformOrigin } from '#lib/server/config.js';
import { featureEnabled, reconcilePlatformDomains, startFailoverLoop } from '@skiff/core';
import { checkCsrf } from '#lib/server/csrf.js';
import { sqlite } from '#lib/server/db.js';
import { needsSetup, setupUrl } from '#lib/server/setup.js';
import { currentSetupToken } from '#lib/server/setup-token.js';
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
	// A fresh install: say where to finish setup on every boot until an owner exists, so the link
	// is always one `journalctl -u skiff-control-plane | grep setup` away (D102).
	if (needsSetup(sqlite)) {
		const { token, file } = currentSetupToken();
		console.info(`[setup] No owner account yet. Finish setup at ${setupUrl(platformOrigin, token)} (token: ${file})`);
	}

	// Settings → Domains restarts us with new domains: move stored hosts and re-push routes (D105).
	try {
		const domains = reconcilePlatformDomains(sqlite, { platformOrigin, contentDomain });
		if (domains.changed)
			console.info(
				`[domains] now ${platformOrigin}, sites at *.${contentDomain}` +
					(domains.previousContentDomain !== contentDomain
						? ` (moved ${domains.previews} preview and ${domains.storage} storage host(s) from ${domains.previousContentDomain})`
						: ''),
			);
	} catch (error) {
		console.error('[domains] could not reconcile stored hosts:', error);
	}

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
		// The failover controller (docs/CLUSTERING.md §8.3): ticks every `controlPlane.renewSeconds`
		// under its lease, so only one primary ever moves copies or starts a database failover.
		// A standby returned above and never takes the lease. Errors are logged at most once a minute.
		let lastFailoverError = 0;
		// Read-replica promotion (C7) as the controller's automatic database path. Opt-in on top of
		// `failover.enabled`: without the object-store lease a partitioned primary is not self-fenced
		// (docs/CLUSTERING.md §9.3). Without it a lost primary is a manual event and an alert.
		if (featureEnabled(core.ctx.config, 'DB_AUTO_PROMOTE'))
			core.failover.registerDatabaseHandler(core.databaseReplicas.failoverHandler());
		startFailoverLoop(core.failover, {
			onError: (error) => {
				if (Date.now() - lastFailoverError < 60_000) return;
				lastFailoverError = Date.now();
				console.error('[failover]', error);
			},
		});
		// Metric alert rules (docs/ALERTS.md): each rule has its own interval (≥ 1 min); this
		// tick only picks up the ones that are due, so a rule runs at most ~20 s late.
		setInterval(() => {
			void core.alerts.evaluateDue().catch((error) => console.error('[alerts]', error));
		}, 20_000).unref?.();
		// Jobs (plan 09): fire due crons every 10 s so a run starts close to its minute; the
		// 60 s maintenance sweep also fires them, and a conditional update keeps each fire single.
		setInterval(() => {
			try {
				core.jobs.scheduleDue();
			} catch (error) {
				console.error('[jobs]', error);
			}
		}, 10_000).unref?.();
		// Log drains (DESIGN §8): ship new lines every 5 s. A drain is leased while it is delivered
		// and a tick that is still running skips the next, so a slow receiver never overlaps itself.
		setInterval(() => {
			void core.logDrains.deliverDue().catch((error) => console.error('[log-drains]', error));
		}, 5_000).unref?.();
		// Flows (docs/FLOWS.md): signals and starts advance runs at once; this loop handles retries
		// after backoff, wait timeouts and cancels requested while another process held the run.
		setInterval(() => {
			try {
				void core.flows.drive().settled.catch((error) => console.error('[flows]', error));
			} catch (error) {
				console.error('[flows]', error);
			}
		}, 5_000).unref?.();
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
			activeOrganizationId: session.session.activeOrganizationId,
		});
	} else if (event.request.headers.get('authorization')) {
		event.locals.principal = await principalFromRequest(event.request);
	}

	// The REST API is bearer/session authenticated throughout; answer 401 here, as JSON, so no handler
	// can turn a missing principal into a 500 (a `Response` thrown outside `route()` would).
	if (!event.locals.principal && isAuthenticatedApi(event.url.pathname))
		return withFrameProtection(
			Response.json({ error: 'unauthorized', message: 'Sign in or send a valid API key.' }, { status: 401 }),
		);

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
 * The native database studio (D96) is a normal page, so it needs no exception.
 */
function withFrameProtection(response: Response): Response {
	try {
		applyFrameHeaders(response.headers);
		return response;
	} catch {
		// Immutable headers (e.g. a proxied fetch response): copy once so the headers can be set.
		const copy = new Response(response.body, response);
		applyFrameHeaders(copy.headers);
		return copy;
	}
}

function applyFrameHeaders(headers: Headers): void {
	const csp = headers.get('content-security-policy');
	// A route that explicitly allows same-origin framing (the dashboard's PDF preview) keeps it.
	const selfFramed = /frame-ancestors\s+'self'\s*(?:;|$)/i.test(csp ?? '');
	headers.set('x-frame-options', selfFramed ? 'SAMEORIGIN' : 'DENY');
	if (!csp?.includes('frame-ancestors')) {
		headers.set(
			'content-security-policy',
			csp ? `${csp}; frame-ancestors 'none'` : "frame-ancestors 'none'",
		);
	}
}

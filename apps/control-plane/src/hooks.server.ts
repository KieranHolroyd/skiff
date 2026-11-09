import { building } from '$app/env';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { getMigrations } from 'better-auth/db/migration';
import type { RequestEvent } from '@sveltejs/kit';
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
import { auth, backfillApiKeyRateLimits, ensurePlatformAdmin } from '#lib/server/auth.js';
import { contentDomain, platformOrigin } from '#lib/server/config.js';
import { featureEnabled, reconcilePlatformDomains, startFailoverLoop } from '@yoal/core';
import { ipInCidr } from '@yoal/contracts';
import { checkCsrf } from '#lib/server/csrf.js';
import { sqlite } from '#lib/server/db.js';
import { needsSetup, setupUrl } from '#lib/server/setup.js';
import { currentSetupToken } from '#lib/server/setup-token.js';
import { core } from '#lib/server/core.js';
import { isDevContentHost, serveDevContent } from '#lib/server/dev-content.js';
import { principalFromRequest, principalFromSession } from '#lib/server/principal.js';
import { enforceOwnerSecondFactor, userHasSecondFactor } from '#lib/server/second-factor.js';
import { isExemptBeforeSecondFactor, secondFactorState } from '#lib/server/second-factor-policy.js';
import { requireSsoRefusalForUser, signInRefusalForUser } from '#lib/server/sso-enforcement.js';
import { syncSsoProviders } from '#lib/server/sso-sync.js';
import {
	reportBackgroundError,
	reportErrorResponse,
	reportRequestError,
	setServerErrorSink,
	withErrorContext,
} from '#lib/server/server-errors.js';

// Settings → Server errors records into the core's store from here on (docs/SERVER-ERRORS.md).
setServerErrorSink(core.serverErrors);

/**
 * Apply Better Auth's schema on boot.
 * TODO(release): replace with forward-only Drizzle migrations run by the updater after a
 * SQLite snapshot (DESIGN §12); auto-migrate is only acceptable during the build phase.
 */
export const init: ServerInit = async () => {
	if (building) return;
	const { runMigrations } = await getMigrations(auth.options);
	await runMigrations();
	const syncedProviders = syncSsoProviders();
	if (syncedProviders > 0) console.info(`[sso] synced ${syncedProviders} provider(s) to Better Auth`);
	const lifted = backfillApiKeyRateLimits();
	if (lifted > 0) console.info(`[auth] raised rate limit on ${lifted} API key(s)`);
	const promoted = ensurePlatformAdmin();
	if (promoted) console.info(`[auth] made the bootstrap user ${promoted} the platform admin`);
	// A fresh install: say where to finish setup on every boot until an owner exists, so the link
	// is always one `journalctl -u yoal-control-plane | grep setup` away (D102).
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
	if (process.env.YOAL_STANDBY === '1') {
		console.info('[standby] serving requests only; background work stays with the primary');
		return;
	}

	// One maintenance loop per process (HMR can call init more than once).
	const global = globalThis as typeof globalThis & { __yoalMaintenance?: ReturnType<typeof setInterval> };
	if (!global.__yoalMaintenance) {
		global.__yoalMaintenance = setInterval(() => {
			void core.maintenance.run().catch((error) => reportBackgroundError('maintenance', error));
		}, 60_000);
		global.__yoalMaintenance.unref?.();
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
				reportBackgroundError('failover', error);
			},
		});
		// Metric alert rules (docs/ALERTS.md): each rule has its own interval (≥ 1 min); this
		// tick only picks up the ones that are due, so a rule runs at most ~20 s late.
		setInterval(() => {
			void core.alerts.evaluateDue().catch((error) => reportBackgroundError('alerts', error));
		}, 20_000).unref?.();
		// Jobs (plan 09): fire due crons every 10 s so a run starts close to its minute; the
		// 60 s maintenance sweep also fires them, and a conditional update keeps each fire single.
		setInterval(() => {
			try {
				core.jobs.scheduleDue();
			} catch (error) {
				reportBackgroundError('jobs', error);
			}
		}, 10_000).unref?.();
		// Log drains (DESIGN §8): ship new lines every 5 s. A drain is leased while it is delivered
		// and a tick that is still running skips the next, so a slow receiver never overlaps itself.
		setInterval(() => {
			void core.logDrains.deliverDue().catch((error) => reportBackgroundError('log-drains', error));
		}, 5_000).unref?.();
		// Flows (docs/FLOWS.md): signals and starts advance runs at once; this loop handles retries
		// after backoff, wait timeouts and cancels requested while another process held the run.
		setInterval(() => {
			try {
				void core.flows.drive().settled.catch((error) => reportBackgroundError('flows', error));
			} catch (error) {
				reportBackgroundError('flows', error);
			}
		}, 5_000).unref?.();
		// Pick up mass operations whose runner died with the previous process (docs/OPERATIONS.md §2.2).
		setTimeout(() => {
			try {
				const resumed = core.operations.resume();
				if (resumed.length) console.info(`[operations] resumed ${resumed.length} operation(s)`);
			} catch (error) {
				reportBackgroundError('operations', error);
			}
		}, 65_000).unref?.();
	}
};

/**
 * Every request runs inside an error context (Settings → Server errors, docs/SERVER-ERRORS.md):
 * exceptions are recorded by `handleError` and the REST API's `errorResponse`, and a 5xx answered
 * without one is recorded here as a bare response.
 */
export const handle: Handle = ({ event, resolve }) =>
	withErrorContext(event, async () => {
		try {
			const response = await handleRequest({ event, resolve });
			if (response.status >= 500) reportErrorResponse(event, response);
			return response;
		} catch (error) {
			// `resolve` turns load and endpoint errors into responses; only our own hook code lands here.
			reportRequestError(error, { event });
			throw error;
		}
	});

/**
 * Unexpected errors in loads, actions and endpoints, recorded with their request. App errors
 * (`error(…)`), framework errors (404s) and validation errors are expected and left alone. The
 * issue id becomes the error page's reference so an admin can find it in Settings.
 */
export const handleError: HandleServerError = (caught) => {
	if (caught.kind !== 'unknown') return;
	const { error, event } = caught;
	console.error(`[${event.request.method} ${event.route.id ?? event.url.pathname}]`, error);
	const errorId = reportRequestError(error, { event, status: 500 });
	return errorId ? { errorId } : undefined;
};

/**
 * Public user-pool endpoints: OIDC discovery/JWKS and the OAuth code flow. They authenticate with
 * a client secret, PKCE or the pool's own bearer token, never the platform session (IAM.md §11.2).
 */
const USER_POOL_PUBLIC_API = /^\/api\/v1\/user-pools\/[^/]+\/(?:oauth\/|\.well-known\/)/;
const USER_POOL_OAUTH_API = /^\/api\/v1\/user-pools\/[^/]+\/oauth\//;

const handleRequest: Handle = async ({ event, resolve }) => {
	// Dev server only: serve `<slug>.localhost` content hosts straight from the local object store
	// instead of requiring the agent + Caddy. Production never reaches this branch.
	if (isDevContentHost(event.url.hostname)) return serveDevContent(event);

	// Hosted user-pool pages are the pool's own sign-in surface. They use a per-pool cookie and
	// must keep working when the platform is signed out or fails over, so the platform session,
	// its auth policy and second-factor gate do not apply. Our forms carry their own CSRF token.
	if (event.url.pathname.startsWith('/pool/')) {
		const csrf = checkCsrf(event.request, event.url, platformOrigin);
		if (!csrf.ok) return new Response(`Forbidden: ${csrf.reason}`, { status: 403 });
		return withFrameProtection(await svelteKitHandler({ event, resolve, auth, building }));
	}

	const csrf = USER_POOL_OAUTH_API.test(event.url.pathname)
		? { ok: true as const }
		: checkCsrf(event.request, event.url, platformOrigin);
	if (!csrf.ok) return new Response(`Forbidden: ${csrf.reason}`, { status: 403 });

	const session = await auth.api.getSession({ headers: event.request.headers });
	event.locals.user = session?.user;
	event.locals.session = session?.session;
	if (session?.user) {
		event.locals.principal = principalFromSession(session.user.id, event.request, {
			name: session.user.name ?? undefined,
			activeOrganizationId: session.session.activeOrganizationId,
			session: session.session,
		});
	} else if (event.request.headers.get('authorization')) {
		event.locals.principal = await principalFromRequest(event.request);
	}

	// Org auth policy (IAM.md I21, §8.5): session maximum age, idle timeout, IP allowlist and the
	// allowed-methods / required-SSO rule. Sign-in methods are recorded on the session at creation;
	// this is the backstop that covers passkey, GitHub and SSO as well as password and magic link.
	const policyOrgId = event.locals.principal?.orgId ?? session?.session.activeOrganizationId ?? undefined;
	const policy = policyOrgId ? core.authPolicy.forOrg(policyOrgId) : null;
	if (session && event.locals.principal) {
		const rejection = enforceSessionPolicy(event, session, policyOrgId, policy);
		if (rejection) return withFrameProtection(rejection);
	}

	// The REST API is bearer/session authenticated throughout; answer 401 here, as JSON, so no handler
	// can turn a missing principal into a 500 (a `Response` thrown outside `route()` would).
	if (!event.locals.principal && isAuthenticatedApi(event.url.pathname))
		return withFrameProtection(
			Response.json({ error: 'unauthorized', message: 'Sign in or send a valid API key.' }, { status: 401 }),
		);

	// Second factor (D10 + IAM.md I21): owner sessions, and every session when the org policy says
	// so, must have proved a passkey or authenticator code before reaching anything beyond /two-factor.
	if (session && event.locals.principal && !USER_POOL_PUBLIC_API.test(event.url.pathname) && !isExemptBeforeSecondFactor(event.url.pathname)) {
		const requiresSecondFactor =
			(enforceOwnerSecondFactor && event.locals.principal.permissions.has('iam:manage-owners')) ||
			Boolean(policy?.require2fa);
		const state = secondFactorState({
			enforce: enforceOwnerSecondFactor,
			role: event.locals.principal.role,
			kind: event.locals.principal.kind,
			sessionFactor: (session.session as { secondFactor?: string | null }).secondFactor,
			hasFactor: requiresSecondFactor && userHasSecondFactor(session.user.id),
			requireTwoFactor: Boolean(policy?.require2fa),
		});
		if (state !== 'satisfied') return withFrameProtection(secondFactorRequired(event));
	}

	const response = await svelteKitHandler({ event, resolve, auth, building });
	return withFrameProtection(response);
};

interface PolicySession {
	user: { id: string };
	session: {
		id: string;
		createdAt: Date | string;
		activeOrganizationId?: string | null;
		lastSeenAt?: number | null;
		signInMethod?: string | null;
	};
}

/**
 * Enforce the org auth policy against a live session. Returns a response when the session is
 * refused (and deletes the session row), or `undefined` to continue. `lastSeenAt` is written at
 * most once a minute, which is precise enough for an idle timeout and keeps writes off the hot path.
 */
function enforceSessionPolicy(
	event: RequestEvent,
	session: PolicySession,
	orgId: string | undefined,
	policy: ReturnType<typeof core.authPolicy.forOrg> | null,
): Response | undefined {
	if (!policy) return undefined;
	const now = Date.now();
	const createdAt = new Date(session.session.createdAt).getTime();
	const lastSeenAt = session.session.lastSeenAt ?? createdAt;

	if (policy.sessionMaxAge !== null && now - createdAt > policy.sessionMaxAge * 1000)
		return endPolicySession(event, session.session.id, 'session_expired', 'Your session reached its maximum age. Sign in again.');
	if (policy.idleTimeout !== null && now - lastSeenAt > policy.idleTimeout * 1000)
		return endPolicySession(event, session.session.id, 'session_idle', 'Your session timed out. Sign in again.');

	if (policy.ipAllowlist.length > 0) {
		const ip = clientIp(event.request);
		if (!ip || !policy.ipAllowlist.some((cidr) => ipInCidr(ip, cidr)))
			return endPolicySession(
				event,
				session.session.id,
				'ip_not_allowed',
				'Your network is not allowed by this organisation’s sign-in policy.',
			);
	}

	const method = session.session.signInMethod;
	if (method) {
		const refusal = signInRefusalForUser(session.user.id, method as Parameters<typeof signInRefusalForUser>[1]);
		if (refusal)
			return endPolicySession(event, session.session.id, 'sign_in_policy', refusal);
	} else {
		const refusal = requireSsoRefusalForUser(session.user.id);
		if (refusal) return endPolicySession(event, session.session.id, 'sign_in_policy', refusal);
	}

	if (now - lastSeenAt > 60_000) {
		sqlite.run('UPDATE session SET lastSeenAt = ? WHERE id = ?', [now, session.session.id]);
		session.session.lastSeenAt = now;
	}
	return undefined;
}

/** Delete the session and answer the request as signed out. Auth API calls continue so Better Auth
 *  can report the missing session itself rather than receiving an HTML redirect. */
function endPolicySession(
	event: RequestEvent,
	sessionId: string,
	code: string,
	message: string,
): Response | undefined {
	sqlite.run('DELETE FROM session WHERE id = ?', [sessionId]);
	event.locals.user = undefined;
	event.locals.session = undefined;
	event.locals.principal = undefined;
	if (event.url.pathname.startsWith('/api/auth/')) return undefined;

	const status = code === 'ip_not_allowed' || code === 'sign_in_policy' ? 403 : 401;
	if (isAuthenticatedApi(event.url.pathname))
		return Response.json({ error: code, message }, { status });
	if (event.request.method === 'GET' || event.request.method === 'HEAD') {
		const location = `/login?error=${code}`;
		if (event.isDataRequest)
			return Response.json({ type: 'redirect', location }, { headers: { 'cache-control': 'no-store' } });
		if ((event.request.headers.get('accept') ?? '').includes('text/html'))
			return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
	}
	return Response.json({ error: code, message }, { status });
}

/** The request's client address, before it is hashed for audit (same order as principal.ts). */
function clientIp(request: Request): string | undefined {
	return (
		request.headers.get('cf-connecting-ip') ??
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
		request.headers.get('x-real-ip') ??
		undefined
	);
}

/** `/api/v1/**` except the endpoints that authenticate themselves (CLI code exchange). */
function isAuthenticatedApi(pathname: string): boolean {
	if (pathname === '/api/v1') return true;
	return (
		pathname.startsWith('/api/v1/') &&
		pathname !== '/api/v1/cli/token' &&
		// Public user-pool OIDC discovery and code flow (IAM.md §11.2).
		!USER_POOL_PUBLIC_API.test(pathname) &&
		// Yoal Access sign-in: the agent sends an unauthenticated browser here, and the handler
		// redirects to `/login` (IAM.md I25, §11.1).
		pathname !== '/api/v1/access/authorize' &&
		// `/login` asks this before a session exists (email → IdP routing).
		pathname !== '/api/v1/sso/resolve'
	);
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

import type { RequestHandler } from './$types';
import {
	evaluateAccessPolicy,
	type AccessIdentity,
	type AccessPolicy,
	type Principal,
} from '@skiff/contracts';
import { userPoolSessionCookieName, type UserPoolUserView } from '@skiff/core';
import { core } from '#lib/server/core.js';

/**
 * Skiff Access login (IAM.md I25, §11.1).
 *
 * The agent redirects an unauthenticated visitor here with `host` and `return`. This endpoint
 * evaluates the host's ordered policy against whichever identity the request carries:
 *
 *  - a platform session (org groups, any member, email/domain, SSO provider, CIDR);
 *  - a user pool session cookie or bearer access token named by a `userPool` rule (pool and its
 *    groups), so an app's own end users can pass without a platform account;
 *  - an anonymous request (CIDR and service-token rules), for callers the agent could not decide.
 *
 * Only an `allow` mints the one-time, host-bound code the agent exchanges for its site cookie. When
 * no pool session exists and the policy names a pool, the visitor goes to that pool's hosted login
 * (with this URL as `return_to`) rather than the platform login.
 */

function html(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
	});
}

function escape(value: string): string {
	return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/** Only content hosts this platform serves may be a return target. */
function allowedHost(host: string): boolean {
	const clean = host.trim().toLowerCase().replace(/\.$/, '');
	if (!clean) return false;
	return core.access.isAllowedReturnHost(clean);
}

function page(title: string, message: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Skiff</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;display:grid;place-items:center;min-height:100svh;margin:0}
main{width:min(420px,90vw);background:#171717;border:1px solid #333;border-radius:12px;padding:24px}
h1{font-size:18px;margin:0 0 8px}p{color:#a3a3a3;margin:0}</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body></html>`;
}

function nextPath(returnUrl: URL | null): string | undefined {
	if (!returnUrl) return undefined;
	return `${returnUrl.pathname}${returnUrl.search}` || '/';
}

/** The pools a policy names, in rule order. `login` may only be offered for one of these. */
function policyPoolIds(policy: Pick<AccessPolicy, 'rules'>): string[] {
	return [
		...new Set(
			policy.rules.flatMap((rule) =>
				rule.matcher.type === 'userPool' ? [rule.matcher.poolId] : [],
			),
		),
	];
}

interface PoolIdentity {
	poolId: string;
	user: UserPoolUserView;
	groups: string[];
}

/** Engine groups win; public metadata (`groups`, else `poolGroups`) is the legacy fallback. */
function poolGroups(poolId: string, user: UserPoolUserView): string[] {
	const engine = core.ctx.userPoolEngine.groupsForUser(poolId, user.id);
	if (engine.length > 0) return engine;
	const raw = user.metadata.groups ?? user.metadata.poolGroups;
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((value): value is string => typeof value === 'string')
		.map((value) => value.trim())
		.filter(Boolean);
}

/**
 * Resolve a pool identity from a bearer access token first, then the pool's own session cookie.
 * A pool session cookie is per pool, so only pools named by this policy are consulted.
 */
async function resolvePoolIdentity(
	event: Parameters<RequestHandler>[0],
	poolIds: readonly string[],
): Promise<PoolIdentity | null> {
	const authorization = event.request.headers.get('authorization');
	const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
	if (bearer) {
		for (const poolId of poolIds) {
			const user = await core.ctx.userPoolEngine.verifyAccessToken(poolId, bearer);
			if (user) return { poolId, user, groups: poolGroups(poolId, user) };
		}
	}
	for (const poolId of poolIds) {
		const context = core.ctx.userPoolEngine.session(
			poolId,
			event.cookies.get(userPoolSessionCookieName(poolId)),
		);
		if (context) return { poolId, user: context.user, groups: poolGroups(poolId, context.user) };
	}
	return null;
}

/**
 * The SSO provider that authenticated this user, when the session was created by SSO. Better Auth's
 * SSO plugin writes the provider id as the linked account's `providerId`, so a join back to
 * `sso_providers` gives the exact id a `ssoProvider` rule names. A session created by password on
 * an account that also has a linked IdP is deliberately not treated as SSO. Better Auth does not
 * record which provider a session used, so a person linked to more than one IdP is ambiguous and
 * fails closed here; a single linked provider is exact.
 */
function ssoProviderForSession(userId: string, orgId: string): string | null {
	try {
		const rows = core.ctx.sqlite
			.query<{ providerId: string }, [string, string]>(
				`SELECT a.providerId AS providerId
				 FROM account a
				 JOIN sso_providers p ON p.id = a.providerId
				 WHERE a.userId = ? AND p.org_id = ? AND p.enabled = 1`,
			)
			.all(userId, orgId);
		return rows.length === 1 ? rows[0]!.providerId : null;
	} catch {
		// The account table or SSO tables may not exist yet on a very old database.
		return null;
	}
}

/**
 * A principal for an identity with no platform account (a pool user, a CIDR visitor or a service
 * token). `accessVisit` only needs the org and a stable subject; it never consults permissions.
 */
function syntheticPrincipal(userId: string, orgId: string): Principal {
	return {
		kind: 'serviceAccount',
		userId,
		orgId,
		role: 'viewer',
		permissions: new Set(),
	};
}

function redirectToPoolLogin(requestUrl: URL, poolId: string): Response {
	const login = new URL(`/pool/${encodeURIComponent(poolId)}/login`, requestUrl.origin);
	login.searchParams.set('return_to', `${requestUrl.pathname}${requestUrl.search}`);
	return new Response(null, {
		status: 302,
		headers: { location: login.toString(), 'cache-control': 'no-store' },
	});
}

const handler: RequestHandler = async (event) => {
	const { request, url, locals } = event;
	const requestedHost = url.searchParams.get('host')?.trim().toLowerCase() ?? '';
	let returnUrl: URL | null = null;
	try {
		returnUrl = url.searchParams.get('return') ? new URL(url.searchParams.get('return')!) : null;
	} catch {
		returnUrl = null;
	}
	const host = requestedHost || returnUrl?.hostname || '';
	if (!host || !allowedHost(host)) return html(page('Unknown site', 'This host is not served by this Skiff platform.'), 404);
	// A code is host-bound; never hand it to a callback on a different host.
	if (returnUrl && returnUrl.hostname.toLowerCase() !== host)
		return html(page('Invalid return address', 'The return address must be the same host.'), 400);

	const resolved = core.accessPolicies.resolveForHost(host);
	if (!resolved) return html(page('Not configured', 'This site does not use Skiff Access.'), 404);
	if (!resolved.policy.enabled) return html(page('Access closed', 'The policy for this site is disabled.'), 403);

	const poolIds = policyPoolIds(resolved.policy);
	const pool = await resolvePoolIdentity(event, poolIds);

	let identity: AccessIdentity;
	let actor: Principal | null = null;
	let poolId: string | null = null;
	if (pool) {
		poolId = pool.poolId;
		const subject = `pool:${pool.poolId}:${pool.user.id}`;
		identity = {
			userId: subject,
			email: pool.user.email.toLowerCase(),
			orgId: resolved.route.project.orgId,
			userPoolId: pool.poolId,
			poolGroups: pool.groups,
		};
		actor = syntheticPrincipal(subject, resolved.route.project.orgId);
	} else if (locals.principal) {
		const principal = locals.principal;
		if (principal.orgId !== resolved.route.project.orgId)
			return html(page('No access', 'You are signed in to a different organisation.'), 403);

		const groups = core.ctx.sqlite
			.query<{ groupId: string }, [string, string]>(
				`SELECT m.group_id AS groupId FROM iam_group_members m
				 JOIN iam_groups g ON g.id = m.group_id
				 WHERE g.org_id = ? AND m.user_id = ?`,
			)
			.all(principal.orgId, principal.userId)
			.map((row) => row.groupId);
		const email = locals.user?.email?.toLowerCase() ?? null;
		const signInMethod = (locals.session as { signInMethod?: string | null } | undefined)?.signInMethod;
		identity = {
			userId: principal.userId,
			email,
			orgId: principal.orgId,
			groups,
			member: true,
			ssoProviderId: signInMethod === 'sso' ? ssoProviderForSession(principal.userId, principal.orgId) : null,
		};
		actor = principal;
	} else {
		// No session yet: identity-free rules (CIDR) can still decide here, and a person-facing rule
		// yields `login`, which the redirect below turns into the right sign-in. Service tokens are
		// deliberately evaluated only by the agent, never converted into a browser cookie.
		identity = {};
	}

	const requestContext = {
		ip: request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
		headers: Object.fromEntries(request.headers.entries()),
	};
	// A service token is an edge credential: the agent checks it on every request and never turns it
	// into a long-lived browser cookie. If an anonymous request reaches this endpoint anyway, only
	// identity-free rules such as CIDR are evaluated, so a leaked token cannot mint a session.
	const decisionPolicy = actor
		? resolved.policy
		: {
				...resolved.policy,
				rules: resolved.policy.rules.filter((rule) => rule.matcher.type !== 'serviceToken'),
			};
	const decision = evaluateAccessPolicy(decisionPolicy, identity, requestContext);
	const auditPrincipal = actor ?? syntheticPrincipal(`service:${host}`, resolved.route.project.orgId);

	core.ctx.audit.record({
		principal: auditPrincipal,
		action: decision === 'allow' ? 'access.allow' : 'access.deny',
		resource: 'access_policy',
		resourceId: resolved.policy.id,
		args: { host, policy: resolved.policy.name, decision, poolId },
		result: decision === 'allow' ? 'ok' : 'error',
		...(decision === 'allow' ? {} : { error: 'access policy denied' }),
	});

	if (decision !== 'allow') {
		// A pool-backed policy sends a visitor without a pool session to that pool's own login,
		// including a platform user whose account does not match the policy's person rules.
		if (!pool && poolIds.length > 0 && (decision === 'login' || locals.principal))
			return redirectToPoolLogin(url, poolIds[0]!);
		// Sign-in happens on the platform origin. The redirect returns to this URL, now authenticated.
		if (decision === 'login' && !locals.principal) {
			const here = `${url.pathname}${url.search}`;
			return new Response(null, {
				status: 302,
				headers: { location: `/login?redirect=${encodeURIComponent(here)}`, 'cache-control': 'no-store' },
			});
		}
		return html(page('No access', 'The access policy for this site does not allow your account.'), 403);
	}

	const visitPrincipal =
		actor ??
		syntheticPrincipal(identity.userId ?? `service:${host}`, resolved.route.project.orgId);
	const visit = core.access.accessVisit(visitPrincipal, host, identity.email ?? null);
	// Stay on the scheme/host/port the visitor used; the callback is handled by the host's agent.
	const target = returnUrl ?? new URL(`https://${host}/`);
	const callback = new URL('/_skiff/access/callback', target);
	callback.searchParams.set('token', visit.token);
	const next = nextPath(returnUrl);
	if (next) callback.searchParams.set('next', next);
	return new Response(null, {
		status: 302,
		headers: { location: callback.toString(), 'cache-control': 'no-store' },
	});
};

export const GET = handler;

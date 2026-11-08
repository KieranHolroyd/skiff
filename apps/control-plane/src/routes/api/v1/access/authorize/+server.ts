import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';

/**
 * Skiff Access login (IAM.md I25, §11.1).
 *
 * The agent redirects an unauthenticated visitor here with `host` and `return`. This endpoint runs
 * on the platform origin, so the platform session cookie is in scope: it authenticates the person,
 * evaluates the host's ordered policy (org group, any member, email/domain, SSO provider, user pool
 * or CIDR), and only on `allow` mints the one-time, host-bound code the agent exchanges for its
 * site cookie. SSO enforcement and user-pool sign-in plug into `/login`; this endpoint already
 * evaluates both matchers so the policy model does not change when they land.
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

const handler: RequestHandler = async ({ request, url, locals }) => {
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

	// Sign-in happens on the platform origin. The redirect returns to this URL, now authenticated.
	if (!locals.principal) {
		const here = `${url.pathname}${url.search}`;
		return new Response(null, {
			status: 302,
			headers: { location: `/login?redirect=${encodeURIComponent(here)}`, 'cache-control': 'no-store' },
		});
	}

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

	const { decision } = core.accessPolicies.decide(
		host,
		{
			userId: principal.userId,
			email,
			orgId: principal.orgId,
			groups,
			member: true,
		},
		{
			ip: request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
			headers: Object.fromEntries(request.headers.entries()),
		},
	);

	core.ctx.audit.record({
		principal,
		action: decision === 'allow' ? 'access.allow' : 'access.deny',
		resource: 'access_policy',
		resourceId: resolved.policy.id,
		args: { host, policy: resolved.policy.name, decision },
		result: decision === 'allow' ? 'ok' : 'error',
		...(decision === 'allow' ? {} : { error: 'access policy denied' }),
	});

	if (decision !== 'allow')
		return html(page('No access', 'The access policy for this site does not allow your account.'), 403);

	const visit = core.access.accessVisit(principal, host, email);
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

import type { RequestHandler } from './$types';
import { and, eq, isNull } from 'drizzle-orm';
import { projects } from '@yoal/db';
import { core } from '#lib/server/core.js';
import { contentDomain } from '#lib/server/config.js';

/**
 * The bridge between a protected content site and the platform (DESIGN §6.4, D20).
 * Deployed content lives on a different registrable domain, so platform session cookies never
 * reach it: the control plane authenticates the human and redirects with a short-lived,
 * host-bound token that the agent verifies statelessly.
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

function safeReturn(raw: string | null): URL | null {
	if (!raw) return null;
	try {
		const url = new URL(raw);
		const allowed =
			url.hostname === contentDomain ||
			url.hostname.endsWith(`.${contentDomain}`) ||
			url.hostname === 'localhost' ||
			url.hostname.endsWith('.localhost') ||
			core.access.isAllowedReturnHost(url.hostname);
		return allowed ? url : null;
	} catch {
		return null;
	}
}

function passwordPage(projectId: string, returnTo: string, error?: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Password required · Yoal</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;display:grid;place-items:center;min-height:100svh;margin:0}
form{width:min(360px,90vw);background:#171717;border:1px solid #333;border-radius:12px;padding:24px;display:grid;gap:12px}
h1{font-size:18px;margin:0 0 4px}p{color:#a3a3a3;margin:0;font-size:13px}
input{background:#0a0a0a;border:1px solid #444;border-radius:8px;padding:10px;color:inherit;font:inherit}
button{background:#e5e5e5;color:#0a0a0a;border:0;border-radius:8px;padding:10px;font:inherit;font-weight:600;cursor:pointer}
.error{color:#f87171;font-size:13px}</style></head>
<body><form method="post" action="/_yoal/site-login">
<input type="hidden" name="project" value="${escape(projectId)}">
<input type="hidden" name="return" value="${escape(returnTo)}">
<h1>This site is password protected</h1>
<p>Enter the password you were given to continue.</p>
<input type="password" name="password" autocomplete="current-password" autofocus required>
${error ? `<p class="error">${escape(error)}</p>` : ''}
<button type="submit">Continue</button>
</form></body></html>`;
}

async function resolveProject(projectId: string) {
	return core.ctx.db.select().from(projects).where(and(eq(projects.id, projectId), isNull(projects.deletedAt))).get();
}

const handler: RequestHandler = async (event) => {
	const { request, url, locals } = event;
	const form = request.method === 'POST' ? await request.formData().catch(() => undefined) : undefined;
	const returnRaw = url.searchParams.get('return') ?? (form ? String(form.get('return') ?? '') : null);
	const target = safeReturn(returnRaw);
	if (!target) return html('<h1>Invalid return URL</h1>', 400);
	const projectId = url.searchParams.get('project') ?? (form ? String(form.get('project') ?? '') : '');
	const project = projectId ? await resolveProject(projectId) : undefined;
	if (!project || project.deletedAt) return html('<h1>Unknown site</h1>', 404);

	// Resolve the access mode for the exact host being visited: preview hosts use the project's
	// preview mode, production/environment hosts their own (D13).
	const resolved = core.access.resolveContentHost(target.hostname);
	if (!resolved || resolved.project.id !== project.id) return html('<h1>Unknown site</h1>', 404);
	const mode = resolved.access;
	const host = target.hostname;

	// Stay on the scheme/host/port the visitor actually used: `https://<host>` would be wrong on a
	// dev server serving `*.localhost` over HTTP on the Vite port.
	const callback = new URL('/_yoal/callback', target);
	const finish = (token: string) => {
		callback.searchParams.set('token', token);
		return new Response(null, { status: 302, headers: { location: callback.toString(), 'cache-control': 'no-store' } });
	};

	const shareToken = target.searchParams.get('_yoal_share');
	if (shareToken) {
		try {
			const visit = core.access.shareAccess(shareToken, {
				ip: request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown',
				userAgent: request.headers.get('user-agent') ?? 'unknown',
				email: locals.user?.email?.toLowerCase(),
			});
			return finish(visit.token);
		} catch (error) {
			const status = (error as { status?: number }).status ?? 410;
			const message = (error as { message?: string }).message ?? 'This share link is no longer valid.';
			return html(
				`<!doctype html><meta charset="utf-8"><title>Link unavailable</title><h1>Link unavailable</h1><p>${escape(message)}</p>`,
				status,
			);
		}
	}

	if (mode === 'public') return new Response(null, { status: 302, headers: { location: target.toString() } });

	// Yoal Access owns sign-in: it evaluates the host's policy on the platform origin.
	if (mode === 'access') {
		const authorize = new URL('/api/v1/access/authorize', url.origin);
		authorize.searchParams.set('project', project.id);
		authorize.searchParams.set('host', host);
		authorize.searchParams.set('return', target.toString());
		return new Response(null, { status: 302, headers: { location: authorize.toString(), 'cache-control': 'no-store' } });
	}

	if (mode === 'platform') {
		if (!locals.principal) {
			const here = `${url.pathname}${url.search}`;
			return new Response(null, {
				status: 302,
				headers: { location: `/login?redirect=${encodeURIComponent(here)}` },
			});
		}
		if (locals.principal.orgId !== project.orgId) return html('<h1>You do not have access to this site</h1>', 403);
		const visit = core.access.platformAccess(locals.principal, host);
		return finish(visit.token);
	}

	// Password mode.
	if (request.method === 'POST') {
		const password = form ? String(form.get('password') ?? '') : '';
		try {
			const visit = core.access.passwordAccess(host, password);
			return finish(visit.token);
		} catch {
			return html(passwordPage(project.id, target.toString(), 'Incorrect password.'), 401);
		}
	}
	return html(passwordPage(project.id, target.toString()));
};

export const GET = handler;
export const POST = handler;

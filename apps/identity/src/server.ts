import type { Database } from 'bun:sqlite';
import { CoreError, type Core } from '@skiff/core';
import { identityDesiredSchema } from '@skiff/contracts';
import {
	clearSessionCookie,
	clientCredentials,
	cookieValue,
	escapeHtml,
	jsonResponse,
	parseIdentityPath,
	poolPath,
	redirect,
	renderPage,
	safeReturnTo,
	SESSION_COOKIE,
	sessionCookie,
} from './http.ts';
import { applyIdentityDesired, identityHealth } from './state.ts';

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface IdentityHandlerOptions {
	core: Core;
	sqlite: Database;
	/** Secure cookies when the issuer is served over HTTPS (the normal case behind Caddy). */
	secureCookies: boolean;
	log?: Log;
}

function errorStatus(error: unknown): number {
	return error instanceof CoreError ? error.status : 500;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Something went wrong.';
}

function ipOf(request: Request): string | null {
	const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
	return forwarded || request.headers.get('cf-connecting-ip') || null;
}

/** The browser-facing origin, because Caddy terminates TLS and the upstream request is plain HTTP. */
function requestOrigin(request: Request, url: URL): string {
	const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
	const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || request.headers.get('host') || url.host;
	return `${proto}://${host}`;
}

async function readForm(request: Request): Promise<URLSearchParams> {
	const text = await request.text();
	return new URLSearchParams(text);
}

/**
 * The public issuer surface, mounted at `auth.<sitesDomain>/<poolId>` (docs/IAM.md §11.2). The
 * heavy lifting is `UserPoolService` (discovery/JWKS) and `UserPoolEngineService` (users, sessions,
 * codes, hosted-page primitives); this module is only the HTTP shape.
 */
export function createIdentityHandler(options: IdentityHandlerOptions): (request: Request) => Promise<Response> {
	const { core, secureCookies } = options;

	const page = (poolId: string, title: string, body: string, status = 200): Response => {
		try {
			const info = core.userPools.publicInfo(poolId);
			return renderPage({ poolName: info.name, title, body, theme: info.theme, status });
		} catch {
			return renderPage({ poolName: 'Skiff Identity', title, body, status });
		}
	};

	const errorPage = (poolId: string, error: unknown): Response =>
		page(
			poolId,
			'Sign-in problem',
			`<h1>Sign-in problem</h1><p class="error">${escapeHtml(errorMessage(error))}</p><nav><a href="${poolPath(poolId, 'login')}">Back to sign in</a></nav>`,
			errorStatus(error),
		);

	const login = async (request: Request, url: URL, poolId: string): Promise<Response> => {
		const info = core.userPools.publicInfo(poolId);
		if (request.method === 'POST') {
			const form = await readForm(request);
			const result = await core.userPoolEngine.signIn(
				poolId,
				form.get('email') ?? '',
				form.get('password') ?? '',
			);
			const returnTo = safeReturnTo(form.get('return_to'), '/', requestOrigin(request, url));
			if (result.mfaRequired && result.mfaToken) {
				return page(
					poolId,
					'Two-factor code',
					`<h1>Two-factor code</h1><p>Enter the code from your authenticator app.</p>
					 <form method="post" action="${poolPath(poolId, 'mfa')}">
					 <input type="hidden" name="mfa_token" value="${escapeHtml(result.mfaToken)}">
					 <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
					 <label for="code">Code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
					 <button type="submit">Continue</button></form>`,
				);
			}
			return redirect(returnTo, { 'set-cookie': sessionCookie(poolId, result.token, secureCookies) });
		}
		const returnTo = safeReturnTo(url.searchParams.get('return_to'), '/', requestOrigin(request, url));
		const signup = info.signupMode === 'open'
			? `<nav><a href="${poolPath(poolId, 'signup')}">Create an account</a><a href="${poolPath(poolId, 'reset')}">Forgot password</a><a href="${poolPath(poolId, 'magic')}">Email me a link</a></nav>`
			: `<nav><a href="${poolPath(poolId, 'reset')}">Forgot password</a><a href="${poolPath(poolId, 'magic')}">Email me a link</a></nav>`;
		return page(
			poolId,
			'Sign in',
			`<h1>Sign in to ${escapeHtml(info.name)}</h1><p>Use your account for this app.</p>
			 <form method="post" action="${poolPath(poolId, 'login')}">
			 <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
			 <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
			 <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
			 <button type="submit">Sign in</button></form>${signup}`,
		);
	};

	const signup = async (request: Request, url: URL, poolId: string): Promise<Response> => {
		const info = core.userPools.publicInfo(poolId);
		if (info.signupMode !== 'open') {
			return page(poolId, 'Invite only', '<h1>Invite only</h1><p>This app creates accounts by invitation. Ask its administrator for an invite.</p>');
		}
		if (request.method === 'POST') {
			const form = await readForm(request);
			const email = form.get('email') ?? '';
			const password = form.get('password') ?? '';
			await core.userPoolEngine.signUp(
				poolId,
				email,
				password,
				form.get('name') ?? undefined,
				{ ...(form.get('invite') ? { inviteToken: form.get('invite')! } : {}) },
			);
			// A pool that requires verification (or an invite-only pool) has no session yet; send the
			// browser to the sign-in page with the same generic message. Otherwise sign in at once.
			const session = await core.userPoolEngine.signIn(poolId, email, password).catch(() => null);
			if (!session) return redirect(`${poolPath(poolId, 'verify')}?sent=1`);
			return redirect(safeReturnTo(form.get('return_to'), '/', requestOrigin(request, url)), {
				'set-cookie': sessionCookie(poolId, session.token, secureCookies),
			});
		}
		const returnTo = safeReturnTo(url.searchParams.get('return_to'), '/', requestOrigin(request, url));
		const invite = url.searchParams.get('invite') ?? '';
		return page(
			poolId,
			'Create account',
			`<h1>Create your account</h1>
			 <form method="post" action="${poolPath(poolId, 'signup')}">
			 <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
			 ${invite ? `<input type="hidden" name="invite" value="${escapeHtml(invite)}">` : ''}
			 <label for="name">Name</label><input id="name" name="name" autocomplete="name">
			 <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
			 <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" required>
			 <button type="submit">Create account</button></form>
			 <nav><a href="${poolPath(poolId, 'login')}">Already have an account?</a></nav>`,
		);
	};

	const verify = async (request: Request, url: URL, poolId: string): Promise<Response> => {
		if (request.method === 'POST') {
			const form = await readForm(request);
			await core.userPoolEngine.requestEmailVerification(poolId, form.get('email') ?? '', { ip: ipOf(request) });
			return page(poolId, 'Check your email', '<h1>Check your email</h1><p>If that address needs verifying, a new link is on its way.</p>');
		}
		const token = url.searchParams.get('token');
		if (!token) {
			return page(
				poolId,
				'Verify email',
				`<h1>Verify your email</h1><form method="post" action="${poolPath(poolId, 'verify')}">
				 <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required>
				 <button type="submit">Send a new link</button></form>`,
			);
		}
		core.userPoolEngine.verifyEmail(poolId, token);
		return page(poolId, 'Email verified', `<h1>Email verified</h1><p>You can close this page and return to the app.</p><nav><a href="${poolPath(poolId, 'login')}">Sign in</a></nav>`);
	};

	const reset = async (request: Request, url: URL, poolId: string): Promise<Response> => {
		if (request.method === 'POST') {
			const form = await readForm(request);
			const token = form.get('token');
			if (!token) {
				await core.userPoolEngine.requestPasswordReset(poolId, form.get('email') ?? '', { ip: ipOf(request) });
				return page(poolId, 'Check your email', '<h1>Check your email</h1><p>If that account exists, a reset link is on its way.</p>');
			}
			const result = await core.userPoolEngine.resetPassword(poolId, token, form.get('password') ?? '');
			return redirect(poolPath(poolId), { 'set-cookie': sessionCookie(poolId, result.token, secureCookies) });
		}
		const token = url.searchParams.get('token');
		if (!token) {
			return page(
				poolId,
				'Reset password',
				`<h1>Reset your password</h1><form method="post" action="${poolPath(poolId, 'reset')}">
				 <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required>
				 <button type="submit">Send a reset link</button></form>`,
			);
		}
		return page(
			poolId,
			'Choose a new password',
			`<h1>Choose a new password</h1><form method="post" action="${poolPath(poolId, 'reset')}">
			 <input type="hidden" name="token" value="${escapeHtml(token)}">
			 <label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" required>
			 <button type="submit">Save password</button></form>`,
		);
	};

	const magic = async (request: Request, url: URL, poolId: string): Promise<Response> => {
		if (request.method === 'POST') {
			const form = await readForm(request);
			await core.userPoolEngine.requestMagicLink(poolId, form.get('email') ?? '', { ip: ipOf(request) });
			return page(poolId, 'Check your email', '<h1>Check your email</h1><p>If that account exists, a sign-in link is on its way.</p>');
		}
		const token = url.searchParams.get('token');
		if (!token) {
			return page(
				poolId,
				'Email sign-in',
				`<h1>Email sign-in</h1><form method="post" action="${poolPath(poolId, 'magic')}">
				 <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required>
				 <button type="submit">Email me a link</button></form>`,
			);
		}
		const result = await core.userPoolEngine.magicLinkSignIn(poolId, token);
		return redirect(poolPath(poolId), { 'set-cookie': sessionCookie(poolId, result.token, secureCookies) });
	};

	const mfa = async (request: Request, url: URL, poolId: string): Promise<Response> => {
		const form = await readForm(request);
		const result = await core.userPoolEngine.totpVerify(poolId, form.get('mfa_token') ?? '', form.get('code') ?? '');
		return redirect(safeReturnTo(form.get('return_to'), '/', requestOrigin(request, url)), {
			'set-cookie': sessionCookie(poolId, result.token, secureCookies),
		});
	};

	const logout = (request: Request, url: URL, poolId: string): Response => {
		const token = cookieValue(request.headers.get('cookie'), SESSION_COOKIE);
		core.userPoolEngine.logout(poolId, token);
		const requested = url.searchParams.get('post_logout_redirect_uri');
		let target = poolPath(poolId, 'login');
		if (requested) {
			try {
				const candidate = new URL(requested);
				if (candidate.origin === requestOrigin(request, url)) target = candidate.toString();
			} catch {
				// A malformed or foreign target stays on the hosted page.
			}
		}
		return redirect(target, { 'set-cookie': clearSessionCookie(poolId, secureCookies) });
	};

	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const route = parseIdentityPath(url.pathname);
		if (route.kind === 'unknown') return jsonResponse({ error: 'not_found' }, 404);
		if (route.kind === 'health') return jsonResponse({ ok: true });

		try {
			if (route.kind === 'discovery') return jsonResponse(await core.userPools.discovery(route.poolId));
			if (route.kind === 'jwks') return jsonResponse(await core.userPools.jwks(route.poolId));
			if (route.kind === 'oauth') {
				if (route.action === 'authorize') {
					const publicUrl = new URL(`${url.pathname}${url.search}`, requestOrigin(request, url));
					const result = await core.userPoolEngine.authorize({
						poolId: route.poolId,
						clientId: url.searchParams.get('client_id') ?? '',
						redirectUri: url.searchParams.get('redirect_uri') ?? '',
						responseType: url.searchParams.get('response_type') ?? '',
						scope: url.searchParams.get('scope'),
						state: url.searchParams.get('state'),
						nonce: url.searchParams.get('nonce'),
						codeChallenge: url.searchParams.get('code_challenge'),
						codeChallengeMethod: url.searchParams.get('code_challenge_method'),
						sessionToken: cookieValue(request.headers.get('cookie'), SESSION_COOKIE),
						requestUrl: publicUrl.toString(),
					});
					if (result.needsLogin) {
						return redirect(`${poolPath(route.poolId, 'login')}?return_to=${encodeURIComponent(publicUrl.toString())}`);
					}
					return redirect(result.redirect);
				}
				if (route.action === 'token') {
					const form = await readForm(request);
					const credentials = clientCredentials(request.headers.get('authorization'), form);
					const result = await core.userPoolEngine.token({
						poolId: route.poolId,
						grantType: form.get('grant_type') ?? '',
						clientId: credentials.clientId,
						clientSecret: credentials.clientSecret,
						code: form.get('code'),
						redirectUri: form.get('redirect_uri'),
						codeVerifier: form.get('code_verifier'),
					});
					return jsonResponse(result);
				}
				if (route.action === 'userinfo') {
					const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
					const form = request.method === 'POST' ? await readForm(request) : new URLSearchParams();
					const token = bearer || form.get('access_token') || url.searchParams.get('access_token');
					if (!token) {
						return new Response(JSON.stringify({ error: 'invalid_token' }), {
							status: 401,
							headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
						});
					}
					return jsonResponse(await core.userPoolEngine.userinfo(route.poolId, token));
				}
				return logout(request, url, route.poolId);
			}

			if (route.page === 'logout') return logout(request, url, route.poolId);
			if (route.page === 'login') return await login(request, url, route.poolId);
			if (route.page === 'signup') return await signup(request, url, route.poolId);
			if (route.page === 'verify') return await verify(request, url, route.poolId);
			if (route.page === 'reset') return await reset(request, url, route.poolId);
			if (route.page === 'magic') return await magic(request, url, route.poolId);
			if (route.page === 'mfa') return await mfa(request, url, route.poolId);
			return jsonResponse({ error: 'not_found' }, 404);
		} catch (error) {
			if (route.kind === 'oauth' && route.action === 'token') {
				const status = errorStatus(error);
				return jsonResponse(
					{
						error: status === 401 ? 'invalid_grant' : status === 400 ? 'invalid_request' : 'server_error',
						error_description: errorMessage(error),
					},
					status,
				);
			}
			if (route.kind === 'discovery' || route.kind === 'jwks') {
				return jsonResponse({ error: 'not_found' }, errorStatus(error));
			}
			if (route.kind === 'page' || route.kind === 'oauth') return errorPage(route.poolId, error);
			return jsonResponse({ error: 'server_error' }, 500);
		}
	};
}

/**
 * The unix-socket control surface. `skiff-identity` never dials the control plane; the node's
 * agent pushes the non-secret projection here and reads the applied generation back (the
 * `skiff-mail` pattern).
 */
export function createIdentityControlHandler(options: {
	sqlite: Database;
	log?: Log;
}): (request: Request) => Promise<Response> {
	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (url.pathname === '/health' && request.method === 'GET') return jsonResponse(identityHealth(options.sqlite));
		if (url.pathname !== '/state' || request.method !== 'PUT') return jsonResponse({ error: 'not_found' }, 404);
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return jsonResponse({ error: 'invalid_json' }, 400);
		}
		const parsed = identityDesiredSchema.safeParse(body);
		if (!parsed.success) return jsonResponse({ error: 'invalid_state', issues: parsed.error.issues }, 422);
		applyIdentityDesired(options.sqlite, parsed.data);
		options.log?.('info', `Applied identity state g${parsed.data.generation} (${parsed.data.pools.length} pools)`);
		return jsonResponse(identityHealth(options.sqlite));
	};
}

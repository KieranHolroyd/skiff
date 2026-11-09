import type { Database } from 'bun:sqlite';
import { CoreError, randomToken, safeEqual, type Core } from '@yoal/core';
import {
	identityDesiredSchema,
	identityKeyBundleSchema,
	identitySecretsSchema,
} from '@yoal/contracts';
import {
	allowAttempt,
	clearSessionCookie,
	clientCredentials,
	cookieValue,
	csrfCookie,
	CSRF_COOKIE,
	escapeHtml,
	jsonResponse,
	parseIdentityPath,
	poolDisplayName,
	poolPath,
	redirect,
	renderPage,
	safeReturnTo,
	SESSION_COOKIE,
	sessionCookie,
} from './http.ts';
import {
	applyIdentityDesired,
	applyIdentitySecrets,
	exportIdentityKeyBundle,
	identityHealth,
	importIdentityKeyBundle,
} from './state.ts';

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface IdentityHandlerOptions {
	core: Core;
	sqlite: Database;
	/** Secure cookies when the issuer is served over HTTPS (the normal case behind Caddy). */
	secureCookies: boolean;
	version?: string;
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

function hidden(name: string, value: string | null | undefined): string {
	return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value ?? '')}">`;
}

function csrfField(token: string): string {
	return hidden('csrf', token);
}

const PASSKEY_SCRIPT = `<script>
(() => {
  const enc = (value) => {
    const text = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  };
  const dec = (value) => {
    const bytes = new Uint8Array(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  };
  const post = async (url, body) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(parsed.error || 'That did not work. Try again.');
    return parsed;
  };
  const submit = async (pool, csrf, email, returnTo) => {
    const challenge = await post('/' + encodeURIComponent(pool) + '/passkeys/login/options', { csrf, email });
    const options = challenge.options;
    const assertion = await navigator.credentials.get({ publicKey: {
      challenge: enc(options.challenge), rpId: options.rpId, timeout: options.timeout, userVerification: 'required',
      allowCredentials: (options.allowCredentials || []).map((item) => ({ id: enc(item.id), type: 'public-key', transports: item.transports })),
    } });
    if (!assertion) throw new Error('The passkey prompt was cancelled.');
    const response = assertion.response;
    const result = await post('/' + encodeURIComponent(pool) + '/passkeys/login/verify', {
      csrf, challengeId: challenge.challengeId, email, return_to: returnTo,
      response: {
        id: assertion.id, rawId: dec(assertion.rawId), type: assertion.type,
        response: { clientDataJSON: dec(response.clientDataJSON), authenticatorData: dec(response.authenticatorData), signature: dec(response.signature), userHandle: response.userHandle ? dec(response.userHandle) : null },
        clientExtensionResults: assertion.getExtensionResults(), authenticatorAttachment: assertion.authenticatorAttachment,
      },
    });
    window.location.assign(result.redirect);
  };
  const register = async (pool, csrf, name) => {
    const challenge = await post('/' + encodeURIComponent(pool) + '/passkeys/register/options', { csrf });
    const options = challenge.options;
    const credential = await navigator.credentials.create({ publicKey: {
      challenge: enc(options.challenge), rp: { id: options.rp.id, name: options.rp.name },
      user: { id: enc(options.user.id), name: options.user.name, displayName: options.user.displayName },
      pubKeyCredParams: options.pubKeyCredParams.map((item) => ({ alg: item.alg, type: 'public-key' })),
      timeout: options.timeout, attestation: options.attestation || 'none',
      excludeCredentials: (options.excludeCredentials || []).map((item) => ({ id: enc(item.id), type: 'public-key', transports: item.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    } });
    if (!credential) throw new Error('The passkey prompt was cancelled.');
    const response = credential.response;
    await post('/' + encodeURIComponent(pool) + '/passkeys/register/verify', {
      csrf, challengeId: challenge.challengeId, name,
      response: {
        id: credential.id, rawId: dec(credential.rawId), type: credential.type,
        response: { clientDataJSON: dec(response.clientDataJSON), attestationObject: dec(response.attestationObject), transports: typeof response.getTransports === 'function' ? response.getTransports() : [] },
        clientExtensionResults: credential.getExtensionResults(), authenticatorAttachment: credential.authenticatorAttachment,
      },
    });
    window.location.reload();
  };
  const supported = () => window.isSecureContext && 'PublicKeyCredential' in window;
  window.yoalPasskey = { supported, submit, register };
})();
</script>`;

/**
 * The public issuer surface, mounted at `auth.<sitesDomain>/<poolId>` (docs/IAM.md §11.2). The
 * heavy lifting is `UserPoolService` (discovery/JWKS) and `UserPoolEngineService` (users, sessions,
 * codes, hosted-page primitives); this module is only the HTTP shape.
 */
export function createIdentityHandler(options: IdentityHandlerOptions): (request: Request) => Promise<Response> {
	const { core, secureCookies, sqlite } = options;
	const version = options.version ?? process.env.YOAL_IDENTITY_VERSION?.trim() ?? 'dev';
	const requests = new Map<string, number>();
	const record = (route: string, status: number): void => {
		const key = `${route}|${status}`;
		requests.set(key, (requests.get(key) ?? 0) + 1);
	};

	const page = (
		poolId: string,
		title: string,
		body: string,
		status = 200,
		csrf?: string,
	): Response => {
		try {
			const info = core.userPools.publicInfo(poolId);
			return renderPage({
				poolName: info.name,
				title,
				body,
				theme: info.theme,
				status,
				...(csrf ? { headers: { 'set-cookie': csrfCookie(poolId, csrf, secureCookies) } } : {}),
			});
		} catch {
			return renderPage({ poolName: 'Yoal Identity', title, body, status });
		}
	};

	const newCsrf = (poolId: string): string => randomToken(24);

	const csrfValid = (request: Request, poolId: string, form: URLSearchParams): boolean => {
		const expected = cookieValue(request.headers.get('cookie'), CSRF_COOKIE);
		const submitted = form.get('csrf') ?? '';
		return Boolean(expected && submitted && safeEqual(expected, submitted));
	};

	const poolInfo = (poolId: string) => core.userPools.publicInfo(poolId);

	const back = (poolId: string, pageName: string, query = ''): string =>
		`${poolPath(poolId, pageName)}${query ? `?${query}` : ''}`;

	const errorPage = (poolId: string, error: unknown, csrf?: string): Response =>
		page(
			poolId,
			'Sign-in problem',
			`<h1>Sign-in problem</h1><p class="error">${escapeHtml(errorMessage(error))}</p><nav><a href="${poolPath(poolId, 'login')}">Back to sign in</a></nav>`,
			errorStatus(error),
			csrf,
		);

	const sessionRedirect = (request: Request, url: URL, poolId: string): string | null => {
		const token = cookieValue(request.headers.get('cookie'), SESSION_COOKIE);
		if (!token || !core.userPoolEngine.session(poolId, token)) return null;
		return safeReturnTo(url.searchParams.get('return_to'), poolPath(poolId, 'account'), requestOrigin(request, url));
	};

	const loginPage = (
		poolId: string,
		info: ReturnType<typeof poolInfo>,
		csrf: string,
		returnTo: string,
		options: { error?: string; notice?: string; mfaToken?: string; email?: string } = {},
	): Response => {
		const social = core.userPoolEngine.enabledOAuthProviders(poolId);
		const mfa = options.mfaToken;
		const body = mfa
			? `<h1>Two-factor code</h1><p>Enter the code from your authenticator app, or one of your recovery codes.</p>
			   <form method="post" action="${poolPath(poolId, 'login')}">
			   ${csrfField(csrf)}${hidden('action', 'mfa')}${hidden('mfa_token', mfa)}${hidden('return_to', returnTo)}
			   <label for="code">Authentication code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
			   <button type="submit">Verify and sign in</button></form>
			   <nav><a href="${poolPath(poolId, 'login')}">Use a different account</a></nav>`
			: `<h1>Sign in to ${escapeHtml(poolDisplayName(info.name, info.theme))}</h1><p>Use your account for this app.</p>
			   ${
					social.length > 0
						? `<div class="social">${social
								.map(
									(provider) =>
										`<form method="post" action="${poolPath(poolId, 'login')}">${csrfField(csrf)}${hidden('action', 'oauth')}${hidden('provider', provider.provider)}${hidden('return_to', returnTo)}<button class="secondary" type="submit">Continue with ${escapeHtml(provider.label)}</button></form>`,
								)
								.join('')}</div><div class="divider"><span>or use your email</span></div>`
						: ''
				}
			   <button id="passkey-login" class="secondary" type="button" hidden>Sign in with a passkey</button>
			   <form method="post" action="${poolPath(poolId, 'login')}">
			   ${csrfField(csrf)}${hidden('action', 'password')}${hidden('return_to', returnTo)}
			   <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username webauthn" value="${escapeHtml(options.email ?? '')}" required>
			   <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
			   <button type="submit">Sign in</button></form>
			   <form method="post" action="${poolPath(poolId, 'login')}" style="margin-top:12px">
			   ${csrfField(csrf)}${hidden('return_to', returnTo)}
			   <label for="link-email">Email for a one-time link</label><input id="link-email" name="email" type="email" autocomplete="username" value="${escapeHtml(options.email ?? '')}" required>
			   <button class="secondary" type="submit" name="action" value="magic">Email me a sign-in link</button>
			   <button class="secondary" type="submit" name="action" value="reset">Forgot password?</button>
			   </form>
			   <nav><a href="${back(poolId, 'otp', new URLSearchParams({ ...(options.email ? { email: options.email } : {}), ...(returnTo ? { return_to: returnTo } : {}) }).toString())}">Email me a one-time code</a>
			   ${info.signupMode === 'open' ? `<a href="${back(poolId, 'signup', returnTo ? `return_to=${encodeURIComponent(returnTo)}` : '')}">Create an account</a>` : '<span>Invite only. Ask an administrator for an invitation.</span>'}
			   </nav>
			   ${PASSKEY_SCRIPT}
			   <script>
			   (() => {
			     const button = document.getElementById('passkey-login');
			     if (!button || !window.yoalPasskey.supported()) return;
			     button.hidden = false;
			     button.addEventListener('click', async () => {
			       button.disabled = true;
			       try {
			         const email = document.getElementById('email').value;
			         const returnTo = ${JSON.stringify(returnTo)};
			         await window.yoalPasskey.submit(${JSON.stringify(poolId)}, ${JSON.stringify(csrf)}, email, returnTo);
			       } catch (error) {
			         alert(error instanceof Error ? error.message : 'Could not use a passkey.');
			         button.disabled = false;
			       }
			     });
			   })();
			   </script>`;
		return page(
			poolId,
			mfa ? 'Two-factor code' : 'Sign in',
			`${options.notice ? `<div class="notice">${escapeHtml(options.notice)}</div>` : ''}${options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : ''}${body}`,
			200,
			csrf,
		);
	};

	const login = async (request: Request, url: URL, poolId: string): Promise<Response> => {
		const info = poolInfo(poolId);
		const existing = sessionRedirect(request, url, poolId);
		if (existing && request.method !== 'POST') return redirect(existing);
		const csrf = newCsrf(poolId);
		if (request.method === 'POST') {
			const form = await readForm(request);
			if (!csrfValid(request, poolId, form)) return errorPage(poolId, new CoreError('csrf', 'Your sign-in form expired. Reload the page and try again.', 400), csrf);
			const email = (form.get('email') ?? '').trim();
			const action = form.get('action') ?? 'password';
			const returnTo = safeReturnTo(form.get('return_to'), poolPath(poolId, 'account'), requestOrigin(request, url));
			const client = ipOf(request) ?? 'unknown';
			if (action === 'magic' || action === 'reset') {
				if (!email) return loginPage(poolId, info, csrf, returnTo, { error: 'Enter your email address.' });
				if (!allowAttempt(`${action}:${poolId}:${client}`, 10))
					return loginPage(poolId, info, csrf, returnTo, { error: 'Too many attempts. Wait a minute and try again.' });
				if (action === 'magic') await core.userPoolEngine.requestMagicLink(poolId, email, { ip: client });
				else await core.userPoolEngine.requestPasswordReset(poolId, email, { ip: client });
				const next = new URL(back(poolId, 'login', `sent=${action}&return_to=${encodeURIComponent(returnTo)}`), requestOrigin(request, url));
				return redirect(`${next.pathname}${next.search}`);
			}
			if (action === 'oauth') {
				const provider = form.get('provider') ?? '';
				if (!provider) return loginPage(poolId, info, csrf, returnTo, { error: 'Choose a sign-in provider.' });
				if (!allowAttempt(`oauth:${poolId}:${client}`, 10))
					return loginPage(poolId, info, csrf, returnTo, { error: 'Too many sign-in attempts. Wait a minute and try again.' });
				const started = core.userPoolEngine.oauthStart(poolId, provider, { returnTo });
				return redirect(started.redirect);
			}
			if (action === 'mfa') {
				if (!allowAttempt(`mfa:${poolId}:${client}`, 10))
					return loginPage(poolId, info, csrf, returnTo, { error: 'Too many code attempts. Wait a minute and try again.', mfaToken: form.get('mfa_token') ?? '' });
				const result = core.userPoolEngine.totpVerify(poolId, form.get('mfa_token') ?? '', form.get('code') ?? '');
				return redirect(returnTo, { 'set-cookie': sessionCookie(poolId, result.token, secureCookies) });
			}
			if (!email) return loginPage(poolId, info, csrf, returnTo, { error: 'Enter your email and password.' });
			if (!allowAttempt(`login:${poolId}:${email.toLowerCase()}:${client}`, 10))
				return loginPage(poolId, info, csrf, returnTo, { error: 'Too many sign-in attempts. Wait a minute and try again.', email });
			try {
				const result = await core.userPoolEngine.signIn(poolId, email, form.get('password') ?? '', {
					ip: client,
					userAgent: request.headers.get('user-agent'),
					country: request.headers.get('cf-ipcountry') ?? request.headers.get('x-country-code'),
				});
				if (result.mfaRequired && result.mfaToken)
					return loginPage(poolId, info, csrf, returnTo, { mfaToken: result.mfaToken, email });
				return redirect(returnTo, { 'set-cookie': sessionCookie(poolId, result.token, secureCookies) });
			} catch (error) {
				if (error instanceof CoreError) return loginPage(poolId, info, csrf, returnTo, { error: error.message, email });
				throw error;
			}
		}
		const notice =
			url.searchParams.get('verified') === '1'
				? 'Your email address is verified. Sign in to continue.'
				: url.searchParams.get('verify') === 'email'
					? 'Check your inbox for a verification link. Follow it, then sign in.'
					: url.searchParams.get('sent') === 'magic'
						? 'If that address has an account, a sign-in link is on its way.'
						: url.searchParams.get('sent') === 'reset'
							? 'If that address has an account, a password-reset link is on its way.'
							: undefined;
		const error =
			url.searchParams.get('magic') === 'invalid'
				? 'That sign-in link is invalid or has expired. Request a new one below.'
				: url.searchParams.get('oauth') === 'error'
					? 'Social sign-in could not be completed. Try again, or use another method below.'
					: undefined;
		const returnTo = safeReturnTo(url.searchParams.get('return_to'), poolPath(poolId, 'account'), requestOrigin(request, url));
		return loginPage(poolId, info, csrf, returnTo, {
			...(notice ? { notice } : {}),
			...(error ? { error } : {}),
			...(url.searchParams.get('email') ? { email: url.searchParams.get('email')! } : {}),
		});
	};

	const signup = async (request: Request, url: URL, poolId: string): Promise<Response> => {
		const info = poolInfo(poolId);
		if (info.signupMode !== 'open') {
			return page(poolId, 'Invite only', '<h1>Invite only</h1><p>This app creates accounts by invitation. Ask its administrator for an invite.</p>');
		}
		const existing = sessionRedirect(request, url, poolId);
		if (existing && request.method !== 'POST') return redirect(existing);
		const csrf = newCsrf(poolId);
		const invite = url.searchParams.get('invite') ?? '';
		if (request.method === 'POST') {
			const form = await readForm(request);
			if (!csrfValid(request, poolId, form)) return errorPage(poolId, new CoreError('csrf', 'Your sign-up form expired. Reload the page and try again.', 400), csrf);
			const email = (form.get('email') ?? '').trim();
			const password = form.get('password') ?? '';
			const name = form.get('name') ?? '';
			const inviteToken = (form.get('invite') ?? invite).trim();
			const returnTo = safeReturnTo(form.get('return_to'), poolPath(poolId, 'account'), requestOrigin(request, url));
			if (!email || !password) return errorPage(poolId, new CoreError('validation', 'Enter your email and a password.', 400), csrf);
			if (!allowAttempt(`signup:${poolId}:${email.toLowerCase()}:${ipOf(request) ?? 'unknown'}`, 10))
				return errorPage(poolId, new CoreError('rate_limit', 'Too many sign-up attempts. Wait a minute and try again.', 429), csrf);
			try {
				const created = await core.userPoolEngine.signUp(poolId, email, password, name, inviteToken ? { inviteToken } : {});
				if (!created.user.emailVerified && info.requireEmailVerification)
					return redirect(back(poolId, 'login', `verify=email&email=${encodeURIComponent(created.user.email)}`));
				const signedIn = await core.userPoolEngine.signIn(poolId, email, password);
				return redirect(returnTo, { 'set-cookie': sessionCookie(poolId, signedIn.token, secureCookies) });
			} catch (error) {
				if (error instanceof CoreError) return errorPage(poolId, error, csrf);
				throw error;
			}
		}
		const returnTo = safeReturnTo(url.searchParams.get('return_to'), poolPath(poolId, 'account'), requestOrigin(request, url));
		return page(
			poolId,
			'Create account',
			`<h1>Create your account</h1>
			 <form method="post" action="${poolPath(poolId, 'signup')}">
			 ${csrfField(csrf)}${hidden('return_to', returnTo)}${invite ? hidden('invite', invite) : ''}
			 <label for="name">Name</label><input id="name" name="name" autocomplete="name">
			 <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
			 <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" required>
			 <button type="submit">Create account</button></form>
			 <nav><a href="${poolPath(poolId, 'login')}">Already have an account?</a></nav>`,
			200,
			csrf,
		);
	};

	const verify = async (request: Request, url: URL, poolId: string): Promise<Response> => {
		const csrf = newCsrf(poolId);
		if (request.method === 'POST') {
			const form = await readForm(request);
			if (!csrfValid(request, poolId, form)) return errorPage(poolId, new CoreError('csrf', 'Your form expired. Reload the page and try again.', 400), csrf);
			await core.userPoolEngine.requestEmailVerification(poolId, form.get('email') ?? '', { ip: ipOf(request) });
			return page(poolId, 'Check your email', '<h1>Check your email</h1><p>If that address needs verifying, a new link is on its way.</p>', 200, csrf);
		}
		const token = url.searchParams.get('token');
		if (!token) {
			return page(
				poolId,
				'Verify email',
				`<h1>Verify your email</h1><form method="post" action="${poolPath(poolId, 'verify')}">
				 ${csrfField(csrf)}
				 <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required>
				 <button type="submit">Send a new link</button></form>`,
				200,
				csrf,
			);
		}
		try {
			core.userPoolEngine.verifyEmail(poolId, token);
			return redirect(back(poolId, 'login', 'verified=1'));
		} catch {
			return redirect(back(poolId, 'login', 'verify=invalid'));
		}
	};

	const reset = async (request: Request, url: URL, poolId: string): Promise<Response> => {
		const csrf = newCsrf(poolId);
		if (request.method === 'POST') {
			const form = await readForm(request);
			if (!csrfValid(request, poolId, form)) return errorPage(poolId, new CoreError('csrf', 'Your reset form expired. Reload the link and try again.', 400), csrf);
			const token = form.get('token');
			if (!token) {
				await core.userPoolEngine.requestPasswordReset(poolId, form.get('email') ?? '', { ip: ipOf(request) });
				return page(poolId, 'Check your email', '<h1>Check your email</h1><p>If that account exists, a reset link is on its way.</p>', 200, csrf);
			}
			const password = form.get('password') ?? '';
			if (password !== (form.get('confirm') ?? '')) return errorPage(poolId, new CoreError('validation', 'The two passwords do not match.', 400), csrf);
			if (!allowAttempt(`reset:${poolId}:${ipOf(request) ?? 'unknown'}`, 10))
				return errorPage(poolId, new CoreError('rate_limit', 'Too many attempts. Wait a minute and try again.', 429), csrf);
			const result = await core.userPoolEngine.resetPassword(poolId, token, password);
			return redirect(safeReturnTo(form.get('return_to'), poolPath(poolId, 'account'), requestOrigin(request, url)), {
				'set-cookie': sessionCookie(poolId, result.token, secureCookies),
			});
		}
		const token = url.searchParams.get('token');
		if (!token) {
			return page(
				poolId,
				'Reset password',
				`<h1>Reset your password</h1><form method="post" action="${poolPath(poolId, 'reset')}">
				 ${csrfField(csrf)}
				 <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required>
				 <button type="submit">Send a reset link</button></form>`,
				200,
				csrf,
			);
		}
		return page(
			poolId,
			'Choose a new password',
			`<h1>Choose a new password</h1><form method="post" action="${poolPath(poolId, 'reset')}">
			 ${csrfField(csrf)}${hidden('token', token)}${hidden('return_to', url.searchParams.get('return_to'))}
			 <label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" required>
			 <label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required>
			 <button type="submit">Save password</button></form>`,
			200,
			csrf,
		);
	};

	const magic = async (request: Request, url: URL, poolId: string): Promise<Response> => {
		const csrf = newCsrf(poolId);
		if (request.method === 'POST') {
			const form = await readForm(request);
			if (!csrfValid(request, poolId, form)) return errorPage(poolId, new CoreError('csrf', 'Your form expired. Reload the page and try again.', 400), csrf);
			await core.userPoolEngine.requestMagicLink(poolId, form.get('email') ?? '', { ip: ipOf(request) });
			return page(poolId, 'Check your email', '<h1>Check your email</h1><p>If that account exists, a sign-in link is on its way.</p>', 200, csrf);
		}
		const token = url.searchParams.get('token');
		if (!token) {
			return page(
				poolId,
				'Email sign-in',
				`<h1>Email sign-in</h1><form method="post" action="${poolPath(poolId, 'magic')}">
				 ${csrfField(csrf)}
				 <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required>
				 <button type="submit">Email me a link</button></form>`,
				200,
				csrf,
			);
		}
		try {
			const result = await core.userPoolEngine.magicLinkSignIn(poolId, token);
			return redirect(safeReturnTo(url.searchParams.get('return_to'), poolPath(poolId, 'account'), requestOrigin(request, url)), {
				'set-cookie': sessionCookie(poolId, result.token, secureCookies),
			});
		} catch {
			return redirect(back(poolId, 'login', 'magic=invalid'));
		}
	};

	const otp = async (request: Request, url: URL, poolId: string): Promise<Response> => {
		const csrf = newCsrf(poolId);
		const existing = sessionRedirect(request, url, poolId);
		if (existing && request.method !== 'POST') return redirect(existing);
		const returnTo = safeReturnTo(url.searchParams.get('return_to'), poolPath(poolId, 'account'), requestOrigin(request, url));
		if (request.method === 'POST') {
			const form = await readForm(request);
			if (!csrfValid(request, poolId, form)) return errorPage(poolId, new CoreError('csrf', 'Your form expired. Reload the page and try again.', 400), csrf);
			const email = (form.get('email') ?? '').trim();
			const action = form.get('action') ?? 'request';
			if (!email) return errorPage(poolId, new CoreError('validation', 'Enter your email address.', 400), csrf);
			if (action === 'verify') {
				if (!allowAttempt(`otp-verify:${poolId}:${ipOf(request) ?? 'unknown'}`, 10))
					return errorPage(poolId, new CoreError('rate_limit', 'Too many code attempts. Wait a minute and try again.', 429), csrf);
				try {
					const result = await core.userPoolEngine.verifyEmailOtp(poolId, email, (form.get('code') ?? '').trim(), {
						ip: ipOf(request),
						userAgent: request.headers.get('user-agent'),
						country: request.headers.get('cf-ipcountry') ?? request.headers.get('x-country-code'),
					});
					return redirect(returnTo, { 'set-cookie': sessionCookie(poolId, result.token, secureCookies) });
				} catch (error) {
					if (error instanceof CoreError) return errorPage(poolId, error, csrf);
					throw error;
				}
			}
			if (!allowAttempt(`otp-request:${poolId}:${ipOf(request) ?? 'unknown'}`, 10))
				return errorPage(poolId, new CoreError('rate_limit', 'Too many requests. Wait a minute and try again.', 429), csrf);
			await core.userPoolEngine.requestEmailOtp(poolId, email, { ip: ipOf(request) });
			return redirect(`${back(poolId, 'otp', new URLSearchParams({ email, sent: '1', ...(returnTo ? { return_to: returnTo } : {}) }).toString())}`);
		}
		const email = url.searchParams.get('email') ?? '';
		const sent = url.searchParams.get('sent') === '1';
		return page(
			poolId,
			'Email code',
			`${sent ? '<div class="notice">If that address has an account, a six-digit code is on its way. It expires in ten minutes.</div>' : ''}
			 <h1>${sent ? 'Enter your code' : 'Email sign-in code'}</h1>
			 <form method="post" action="${poolPath(poolId, 'otp')}">
			 ${csrfField(csrf)}${hidden('return_to', returnTo)}
			 <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" value="${escapeHtml(email)}" required>
			 ${sent ? '<label for="code">Six-digit code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required>' : ''}
			 <button type="submit" name="action" value="${sent ? 'verify' : 'request'}">${sent ? 'Verify and sign in' : 'Email me a code'}</button>
			 </form>
			 <nav><a href="${poolPath(poolId, 'login')}">Back to sign in</a></nav>`,
			200,
			csrf,
		);
	};

	const account = async (request: Request, url: URL, poolId: string): Promise<Response> => {
		const token = cookieValue(request.headers.get('cookie'), SESSION_COOKIE);
		const session = core.userPoolEngine.session(poolId, token);
		if (!session) return redirect(back(poolId, 'login', url.search ? `return_to=${encodeURIComponent(`${url.pathname}${url.search}`)}` : ''));
		const csrf = newCsrf(poolId);
		if (request.method === 'POST') {
			const form = await readForm(request);
			if (!csrfValid(request, poolId, form)) return errorPage(poolId, new CoreError('csrf', 'Your form expired. Reload the page and try again.', 400), csrf);
			const action = form.get('action') ?? '';
			if (action === 'logout') {
				core.userPoolEngine.logout(poolId, token);
				return redirect(poolPath(poolId, 'login'), { 'set-cookie': clearSessionCookie(poolId, secureCookies) });
			}
			if (action === 'remove-passkey') {
				core.userPoolEngine.deletePasskey(poolId, session.user.id, form.get('passkey_id') ?? '');
				return redirect(poolPath(poolId, 'account'));
			}
			if (action === 'resend-verification') {
				await core.userPoolEngine.requestEmailVerification(poolId, session.user.email, { ip: ipOf(request) });
				return redirect(`${poolPath(poolId, 'account')}?sent=verify`);
			}
			if (action === 'begin-totp') {
				const enrolment = core.userPoolEngine.totpEnrol(poolId, session.user.id);
				return page(
					poolId,
					'Enable two-factor',
					`<h1>Enable two-factor</h1><p>Add this secret to your authenticator app, then enter the six-digit code it shows.</p>
					 <p><code>${escapeHtml(enrolment.secret)}</code></p>
					 <form method="post" action="${poolPath(poolId, 'account')}">
					 ${csrfField(csrf)}${hidden('action', 'confirm-totp')}
					 <label for="code">Code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
					 <button type="submit">Confirm</button></form>`,
					200,
					csrf,
				);
			}
			if (action === 'confirm-totp') {
				const result = core.userPoolEngine.totpConfirm(poolId, session.user.id, form.get('code') ?? '');
				return page(
					poolId,
					'Two-factor enabled',
					`<h1>Two-factor enabled</h1><p>Keep these recovery codes somewhere safe. They are shown once.</p><ul>${result.recoveryCodes.map((code) => `<li><code>${escapeHtml(code)}</code></li>`).join('')}</ul><nav><a href="${poolPath(poolId, 'account')}">Done</a></nav>`,
					200,
					csrf,
				);
			}
			if (action === 'disable-totp') {
				core.userPoolEngine.totpDisable(poolId, session.user.id, form.get('code') ?? '');
				return redirect(poolPath(poolId, 'account'));
			}
		}
		const passkeys = core.userPoolEngine.listPasskeys(poolId, session.user.id);
		const totp = core.userPoolEngine.totpStatus(poolId, session.user.id);
		const groups = core.userPoolEngine.groupsForUser(poolId, session.user.id);
		const notice = url.searchParams.get('sent') === 'verify' ? '<div class="notice">If that address needs verifying, a new link is on its way.</div>' : '';
		return page(
			poolId,
			'Your account',
			`${notice}<h1>Your account</h1><p>${escapeHtml(session.user.email)}${session.user.emailVerified ? '' : ' · unverified'}${groups.length > 0 ? ` · ${escapeHtml(groups.join(', '))}` : ''}</p>
			 <h2 style="font-size:16px">Passkeys</h2>
			 ${passkeys.length === 0 ? '<p>No passkeys yet.</p>' : `<ul>${passkeys.map((passkey) => `<li>${escapeHtml(passkey.name)} <form method="post" action="${poolPath(poolId, 'account')}" style="display:inline">${csrfField(csrf)}${hidden('action', 'remove-passkey')}${hidden('passkey_id', passkey.id)}<button class="secondary" style="width:auto;margin:0;padding:2px 8px" type="submit">Remove</button></form></li>`).join('')}</ul>`}
			 <button id="add-passkey" class="secondary" type="button" hidden>Add a passkey</button>
			 <h2 style="font-size:16px">Two-factor</h2>
			 <p>${totp.enabled ? 'Authenticator app enabled.' : 'Not enabled.'}</p>
			 ${totp.enabled
					? `<form method="post" action="${poolPath(poolId, 'account')}">${csrfField(csrf)}${hidden('action', 'disable-totp')}<label for="code">Code to disable</label><input id="code" name="code" inputmode="numeric" required><button class="secondary" type="submit">Disable two-factor</button></form>`
					: `<form method="post" action="${poolPath(poolId, 'account')}">${csrfField(csrf)}${hidden('action', 'begin-totp')}<button class="secondary" type="submit">Enable two-factor</button></form>`}
			 ${session.user.emailVerified ? '' : `<form method="post" action="${poolPath(poolId, 'account')}">${csrfField(csrf)}${hidden('action', 'resend-verification')}<button class="secondary" type="submit">Resend verification email</button></form>`}
			 <form method="post" action="${poolPath(poolId, 'account')}">${csrfField(csrf)}${hidden('action', 'logout')}<button class="secondary" type="submit">Sign out</button></form>
			 ${PASSKEY_SCRIPT}
			 <script>
			 (() => {
			   const button = document.getElementById('add-passkey');
			   if (!button || !window.yoalPasskey.supported()) return;
			   button.hidden = false;
			   button.addEventListener('click', async () => {
			     button.disabled = true;
			     try { await window.yoalPasskey.register(${JSON.stringify(poolId)}, ${JSON.stringify(csrf)}, 'Passkey'); }
			     catch (error) { alert(error instanceof Error ? error.message : 'Could not add a passkey.'); button.disabled = false; }
			   });
			 })();
			 </script>`,
			200,
			csrf,
		);
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

	const socialCallback = async (request: Request, url: URL, poolId: string, provider: string): Promise<Response> => {
		const failure = back(poolId, 'login', 'oauth=error');
		if (url.searchParams.get('error')) return redirect(failure);
		const code = url.searchParams.get('code');
		const state = url.searchParams.get('state');
		if (!code || !state) return redirect(failure);
		try {
			const result = await core.userPoolEngine.oauthCallback(poolId, provider, code, state);
			const target = safeReturnTo(result.returnTo, poolPath(poolId, 'account'), requestOrigin(request, url));
			return redirect(target, { 'set-cookie': sessionCookie(poolId, result.token, secureCookies) });
		} catch {
			return redirect(failure);
		}
	};

	const passkey = async (request: Request, poolId: string, action: string): Promise<Response> => {
		if (request.method !== 'POST') return jsonResponse({ error: 'not_found' }, 404);
		let body: Record<string, unknown>;
		try {
			const value: unknown = await request.json();
			body = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
		} catch {
			body = {};
		}
		const string = (key: string): string | null => (typeof body[key] === 'string' ? (body[key] as string) : null);
		const csrf = cookieValue(request.headers.get('cookie'), CSRF_COOKIE);
		if (!csrf || !string('csrf') || !safeEqual(csrf, string('csrf')!))
			return jsonResponse({ error: 'Your form expired. Reload the page and try again.' }, 400);
		const client = ipOf(request) ?? 'unknown';
		if (!allowAttempt(`passkey-${action}:${poolId}:${client}`, 10))
			return jsonResponse({ error: 'Too many passkey attempts. Wait a minute and try again.' }, 429);
		const sessionToken = cookieValue(request.headers.get('cookie'), SESSION_COOKIE);
		try {
			if (action === 'login-options') {
				return jsonResponse(await core.userPoolEngine.passkeyLoginOptions(poolId, string('email'), { origin: requestOrigin(request, new URL(request.url)) }));
			}
			if (action === 'login-verify') {
				const response = body.response;
				if (!string('challengeId') || !response || typeof response !== 'object') return jsonResponse({ error: 'Passkey sign-in failed.' }, 401);
				const signedIn = await core.userPoolEngine.passkeyLoginVerify({
					poolId,
					challengeId: string('challengeId')!,
					response: response as never,
					email: string('email'),
					ip: client,
				});
				const target = safeReturnTo(string('return_to'), poolPath(poolId, 'account'), requestOrigin(request, new URL(request.url)));
				return jsonResponse({ redirect: target }, 200, {
					'set-cookie': sessionCookie(poolId, signedIn.token, secureCookies),
				});
			}
			const session = core.userPoolEngine.session(poolId, sessionToken);
			if (!session) return jsonResponse({ error: 'Your session expired. Sign in again.' }, 401);
			if (action === 'register-options')
				return jsonResponse(await core.userPoolEngine.passkeyRegisterOptions(poolId, session.user.id, requestOrigin(request, new URL(request.url))));
			const response = body.response;
			if (!string('challengeId') || !response || typeof response !== 'object') return jsonResponse({ error: 'That passkey could not be registered. Try again.' }, 400);
			const passkey = await core.userPoolEngine.passkeyRegisterVerify({
				poolId,
				userId: session.user.id,
				challengeId: string('challengeId')!,
				response: response as never,
				name: string('name'),
			});
			return jsonResponse({ passkey });
		} catch (error) {
			if (error instanceof CoreError) return jsonResponse({ error: error.message }, error.status);
			return jsonResponse({ error: 'Passkeys are unavailable right now. Try again.' }, 500);
		}
	};

	const metrics = (): Response => {
		const health = identityHealth(sqlite, version);
		const lines = [
			'# HELP yoal_identity_ready Whether the identity process has a usable database and state.',
			'# TYPE yoal_identity_ready gauge',
			`yoal_identity_ready ${health.ready ? 1 : 0}`,
			'# HELP yoal_identity_pools Pools in the last applied projection.',
			'# TYPE yoal_identity_pools gauge',
			`yoal_identity_pools ${health.pools}`,
			'# HELP yoal_identity_generation Last applied desired-state generation.',
			'# TYPE yoal_identity_generation gauge',
			`yoal_identity_generation ${health.generation ?? 0}`,
			'# HELP yoal_identity_secrets_generation Last applied secret-bundle generation.',
			'# TYPE yoal_identity_secrets_generation gauge',
			`yoal_identity_secrets_generation ${health.secretsGeneration ?? 0}`,
			'# HELP yoal_identity_requests_total HTTP requests by route and status.',
			'# TYPE yoal_identity_requests_total counter',
			...[...requests.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, count]) => {
					const [route, status] = key.split('|');
					return `yoal_identity_requests_total{route="${route}",status="${status}"} ${count}`;
				}),
		];
		return new Response(`${lines.join('\n')}\n`, {
			status: 200,
			headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' },
		});
	};

	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const route = parseIdentityPath(url.pathname);
		const label = route.kind === 'page' || route.kind === 'passkey' || route.kind === 'oauth' ? `${route.kind}:${('page' in route ? route.page : 'action' in route ? route.action : '')}` : route.kind;
		let response: Response;
		try {
			if (route.kind === 'unknown') response = jsonResponse({ error: 'not_found' }, 404);
			else if (route.kind === 'health') {
				try {
					response = jsonResponse(identityHealth(sqlite, version));
				} catch {
					response = jsonResponse({ ok: false, ready: false, status: 'unhealthy', version }, 503);
				}
			} else if (route.kind === 'ready') {
				try {
					sqlite.query('SELECT 1').get();
					response = jsonResponse({ ready: true, version });
				} catch {
					response = jsonResponse({ ready: false, version }, 503);
				}
			} else if (route.kind === 'metrics') response = metrics();
			else if (route.kind === 'discovery') response = jsonResponse(await core.userPools.discovery(route.poolId));
			else if (route.kind === 'jwks') response = jsonResponse(await core.userPools.jwks(route.poolId));
			else if (route.kind === 'socialCallback') response = await socialCallback(request, url, route.poolId, route.provider);
			else if (route.kind === 'passkey') response = await passkey(request, route.poolId, route.action);
			else if (route.kind === 'oauth') {
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
						const returnTo = safeReturnTo(publicUrl.toString(), poolPath(route.poolId, 'account'), requestOrigin(request, url));
						response = redirect(`${poolPath(route.poolId, 'login')}?return_to=${encodeURIComponent(returnTo)}`);
					} else response = redirect(result.redirect);
				} else if (route.action === 'token') {
					const form = await readForm(request);
					const credentials = clientCredentials(request.headers.get('authorization'), form);
					response = jsonResponse(
						await core.userPoolEngine.token({
							poolId: route.poolId,
							grantType: form.get('grant_type') ?? '',
							clientId: credentials.clientId,
							clientSecret: credentials.clientSecret,
							code: form.get('code'),
							redirectUri: form.get('redirect_uri'),
							codeVerifier: form.get('code_verifier'),
						}),
					);
				} else if (route.action === 'userinfo') {
					const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
					const form = request.method === 'POST' ? await readForm(request) : new URLSearchParams();
					const token = bearer || form.get('access_token') || url.searchParams.get('access_token');
					if (!token)
						response = new Response(JSON.stringify({ error: 'invalid_token' }), {
							status: 401,
							headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
						});
					else response = jsonResponse(await core.userPoolEngine.userinfo(route.poolId, token));
				} else response = logout(request, url, route.poolId);
			} else if (route.page === 'logout') response = logout(request, url, route.poolId);
			else if (route.page === 'login') response = await login(request, url, route.poolId);
			else if (route.page === 'signup') response = await signup(request, url, route.poolId);
			else if (route.page === 'verify') response = await verify(request, url, route.poolId);
			else if (route.page === 'reset') response = await reset(request, url, route.poolId);
			else if (route.page === 'magic') response = await magic(request, url, route.poolId);
			else if (route.page === 'otp') response = await otp(request, url, route.poolId);
			else if (route.page === 'mfa') response = await login(request, url, route.poolId);
			else if (route.page === 'account') response = await account(request, url, route.poolId);
			else response = jsonResponse({ error: 'not_found' }, 404);
		} catch (error) {
			if (route.kind === 'oauth' && route.action === 'token') {
				const status = errorStatus(error);
				response = jsonResponse(
					{
						error: status === 401 ? 'invalid_grant' : status === 400 ? 'invalid_request' : 'server_error',
						error_description: errorMessage(error),
					},
					status,
				);
			} else if (route.kind === 'discovery' || route.kind === 'jwks') {
				response = jsonResponse({ error: 'not_found' }, errorStatus(error));
			} else if (route.kind === 'page' || route.kind === 'oauth' || route.kind === 'socialCallback')
				response = errorPage(route.poolId, error);
			else response = jsonResponse({ error: 'server_error' }, 500);
		}
		record(label, response.status);
		return response;
	};
}

/**
 * The unix-socket control surface. `yoal-identity` never dials the control plane; the node's
 * agent pushes the non-secret projection, the opened-then-resealed secret bundle and key bundles
 * here and reads health back (the `yoal-mail` pattern).
 */
export function createIdentityControlHandler(options: {
	core?: Core;
	sqlite: Database;
	version?: string;
	log?: Log;
}): (request: Request) => Promise<Response> {
	const version = options.version ?? process.env.YOAL_IDENTITY_VERSION?.trim() ?? 'dev';
	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (url.pathname === '/health' && request.method === 'GET') return jsonResponse(identityHealth(options.sqlite, version));
		if (url.pathname === '/keys/export' && request.method === 'GET') {
			const pool = url.searchParams.get('pool');
			const exported = exportIdentityKeyBundle(options.sqlite, pool ? [pool] : undefined);
			return jsonResponse({
				version: 1,
				bytes: exported.bytes,
				tooLarge: exported.tooLarge,
				// Reporting an oversized bundle instead of shipping it keeps the desired state bounded.
				bundle: exported.tooLarge ? null : Buffer.from(JSON.stringify(exported.bundle), 'utf8').toString('base64'),
			});
		}
		if (url.pathname === '/keys/import' && request.method === 'PUT') {
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return jsonResponse({ error: 'invalid_json' }, 400);
			}
			const raw = (body as { bundle?: unknown } | null)?.bundle;
			let bundle: unknown = raw;
			if (typeof raw === 'string') {
				try {
					bundle = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
				} catch {
					return jsonResponse({ error: 'invalid_bundle' }, 422);
				}
			}
			const parsed = identityKeyBundleSchema.safeParse(bundle);
			if (!parsed.success) return jsonResponse({ error: 'invalid_bundle', issues: parsed.error.issues }, 422);
			const imported = importIdentityKeyBundle(options.sqlite, parsed.data);
			options.log?.('info', `Imported ${imported} identity signing keys`);
			return jsonResponse({ imported });
		}
		if (url.pathname === '/secrets' && request.method === 'PUT') {
			const controlCore = options.core;
			if (!controlCore) return jsonResponse({ error: 'secrets_unavailable' }, 503);
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return jsonResponse({ error: 'invalid_json' }, 400);
			}
			const parsed = identitySecretsSchema.safeParse(body);
			if (!parsed.success) return jsonResponse({ error: 'invalid_secrets', issues: parsed.error.issues }, 422);
			applyIdentitySecrets(options.sqlite, (orgId, value) => controlCore.ctx.secrets.seal(orgId, value), parsed.data);
			// Counts only: the bundle itself never reaches a log line.
			options.log?.(
				'info',
				`Applied identity secrets g${parsed.data.generation} (${parsed.data.pools.length} pools)`,
			);
			return jsonResponse(identityHealth(options.sqlite, version));
		}
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
		return jsonResponse(identityHealth(options.sqlite, version));
	};
}

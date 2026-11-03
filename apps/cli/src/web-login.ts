/**
 * Browser login for the CLI (`skif login --web`).
 *
 * The CLI starts a loopback listener, generates a PKCE verifier + state, and opens the
 * dashboard at `<platform>/cli/login`. After the user approves, the control plane redirects a
 * one-time code to the listener. The CLI posts the code and verifier to `/api/v1/cli/token` and
 * receives a regular API key, which is stored like a `--token` login.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { openExternal } from './browser.ts';
import { normalizePlatformUrl, platformOrigin } from './config.ts';
import { CliError } from './errors.ts';

const LOGIN_PATH = '/cli/login';
const CALLBACK_PATH = '/callback';
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const EXCHANGE_TIMEOUT_MS = 30_000;

export interface WebLoginOptions {
	/** Set false for headless machines; the caller must show the URL itself. */
	openBrowser?: boolean;
	timeoutMs?: number;
	/** Called once with the dashboard URL and whether the browser process started. */
	onReady?: (info: { url: string; opened: boolean }) => void;
	/** Called after the URL is available and the CLI is waiting for the callback. */
	onWaiting?: () => void;
}

export interface WebLoginResult {
	token: string;
	platform: string;
	contentDomain?: string;
}

export async function webLogin(
	platformUrl: string,
	options: WebLoginOptions = {},
): Promise<WebLoginResult> {
	const url = normalizePlatformUrl(platformUrl);
	const origin = platformOrigin(url);
	const state = randomBytes(24).toString('base64url');
	const verifier = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');

	let resolveCode!: (code: string) => void;
	let rejectCode!: (error: Error) => void;
	const codePromise = new Promise<string>((resolve, reject) => {
		resolveCode = resolve;
		rejectCode = reject;
	});

	const handle = (requestUrl: URL): CallbackResponse => {
		if (requestUrl.pathname !== CALLBACK_PATH) return { status: 404, body: 'Not found', html: false };

		// Ignore unrelated local requests (favicons, port scans) instead of cancelling a
		// legitimate pending login.
		if (requestUrl.searchParams.get('state') !== state)
			return callbackPage('Login request rejected', 'The sign-in state did not match.', 400);

		const error = requestUrl.searchParams.get('error');
		if (error) {
			rejectCode(
				new CliError(
					error === 'access_denied'
						? 'Login was cancelled in the browser.'
						: `The platform rejected the login (${error}).`,
					{ code: 'login_cancelled', suggestions: ['Run `skif login --web` to try again.'] },
				),
			);
			return callbackPage('Login cancelled', 'You can close this tab and return to the terminal.');
		}

		const code = requestUrl.searchParams.get('code');
		if (!code) {
			rejectCode(new CliError('The platform did not return a login code.', { code: 'login_failed' }));
			return callbackPage('Login failed', 'You can close this tab and return to the terminal.');
		}

		resolveCode(code);
		return callbackPage('Skiff CLI authorized', 'You can close this tab and return to the terminal.');
	};

	// node:http rather than Bun.serve so the published CLI runs under Node as well as Bun.
	const server = createServer((request, response) => {
		const result = handle(new URL(request.url ?? '/', 'http://127.0.0.1'));
		response.writeHead(result.status, {
			'content-type': result.html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
			connection: 'close',
		});
		response.end(result.body);
	});
	const port = await listenOnLoopback(server);

	const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
	const loginUrl = new URL(`${url}${LOGIN_PATH}`);
	loginUrl.searchParams.set('redirect_uri', redirectUri);
	loginUrl.searchParams.set('state', state);
	loginUrl.searchParams.set('code_challenge', challenge);
	loginUrl.searchParams.set('code_challenge_method', 'S256');

	try {
		const opened = options.openBrowser === false ? false : await openExternal(loginUrl.toString());
		options.onReady?.({ url: loginUrl.toString(), opened });
		options.onWaiting?.();

		const code = await withTimeout(
			codePromise,
			options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			() =>
				new CliError('Timed out waiting for browser approval.', {
					code: 'login_timeout',
					suggestions: ['Run `skif login --web` to try again.'],
				}),
		);

		const response = await fetch(`${url}/api/v1/cli/token`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin,
			},
			body: JSON.stringify({ code, codeVerifier: verifier }),
			signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
		});
		const payload = (await response.json().catch(() => null)) as {
			token?: string;
			platform?: string;
			contentDomain?: string;
			message?: string;
			error?: string;
		} | null;

		if (!response.ok)
			throw new CliError(
				payload?.message ?? `The platform could not complete the login (${response.status}).`,
				{ code: payload?.error ?? 'login_failed' },
			);
		if (!payload?.token)
			throw new CliError('The platform did not return an API key.', { code: 'login_failed' });

		return {
			token: payload.token,
			platform: payload.platform ?? url,
			contentDomain: payload.contentDomain,
		};
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(error()), ms);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

interface CallbackResponse {
	status: number;
	body: string;
	html: boolean;
}

function listenOnLoopback(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			const address = server.address();
			if (address && typeof address === 'object') resolve(address.port);
			else reject(new CliError('Could not start the local login listener.', { code: 'login_failed' }));
		});
	});
}

function callbackPage(title: string, message: string, status = 200): CallbackResponse {
	return {
		status,
		html: true,
		body: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title} · Skiff</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0b0b0c;color:#f5f5f5;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:28rem;padding:2rem;text-align:center}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#a1a1aa;margin:0}
</style></head>
<body><main><h1>${title}</h1><p>${message}</p></main></body>
</html>`,
	};
}

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { webLogin } from './web-login.ts';

let platform: ReturnType<typeof Bun.serve> | undefined;

afterEach(async () => {
	if (platform) await platform.stop(true);
	platform = undefined;
});

function baseUrl(server: ReturnType<typeof Bun.serve>): string {
	return `http://127.0.0.1:${server.port}`;
}

describe('webLogin', () => {
	test('redirects back with a code and exchanges the PKCE verifier for a key', async () => {
		let challenge = '';
		let exchange: { code?: string; codeVerifier?: string } = {};

		platform = Bun.serve({
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === '/cli/login') {
					challenge = url.searchParams.get('code_challenge') ?? '';
					const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
					callback.searchParams.set('code', 'code-123');
					callback.searchParams.set('state', url.searchParams.get('state') ?? '');
					return Response.redirect(callback.toString(), 303);
				}
				if (url.pathname === '/api/v1/cli/token') {
					exchange = (await request.json()) as typeof exchange;
					const actual = createHash('sha256')
						.update(exchange.codeVerifier ?? '')
						.digest('base64url');
					if (actual !== challenge)
						return Response.json({ error: 'invalid_grant', message: 'Bad verifier.' }, { status: 400 });
					return Response.json({
						token: 'yoal_test_token',
						platform: baseUrl(platform!),
						contentDomain: 'sites.test',
					});
				}
				return new Response('not found', { status: 404 });
			},
		});

		const result = await webLogin(baseUrl(platform), {
			openBrowser: false,
			timeoutMs: 2000,
			onReady: ({ url }) => {
				void fetch(url, { redirect: 'follow' }).catch(() => undefined);
			},
		});

		expect(result.token).toBe('yoal_test_token');
		expect(result.contentDomain).toBe('sites.test');
		expect(exchange.code).toBe('code-123');
		expect(challenge).toHaveLength(43);
		expect(exchange.codeVerifier).toHaveLength(43);
	});

	test('reports a cancelled approval', async () => {
		platform = Bun.serve({
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === '/cli/login') {
					const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
					callback.searchParams.set('error', 'access_denied');
					callback.searchParams.set('state', url.searchParams.get('state') ?? '');
					return Response.redirect(callback.toString(), 303);
				}
				return new Response('not found', { status: 404 });
			},
		});

		await expect(
			webLogin(baseUrl(platform), {
				openBrowser: false,
				timeoutMs: 2000,
				onReady: ({ url }) => {
					void fetch(url, { redirect: 'follow' }).catch(() => undefined);
				},
			}),
		).rejects.toThrow('cancelled in the browser');
	});

	test('surfaces a token-exchange error', async () => {
		platform = Bun.serve({
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === '/cli/login') {
					const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
					callback.searchParams.set('code', 'code-123');
					callback.searchParams.set('state', url.searchParams.get('state') ?? '');
					return Response.redirect(callback.toString(), 303);
				}
				if (url.pathname === '/api/v1/cli/token')
					return Response.json(
						{ error: 'invalid_grant', message: 'This login link has expired.' },
						{ status: 400 },
					);
				return new Response('not found', { status: 404 });
			},
		});

		await expect(
			webLogin(baseUrl(platform), {
				openBrowser: false,
				timeoutMs: 2000,
				onReady: ({ url }) => {
					void fetch(url, { redirect: 'follow' }).catch(() => undefined);
				},
			}),
		).rejects.toThrow('This login link has expired.');
	});
});

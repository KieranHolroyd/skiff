import { describe, expect, test } from 'bun:test';
import {
	allowAttempt,
	clientCredentials,
	cookieValue,
	csrfCookie,
	parseIdentityPath,
	poolPath,
	renderPage,
	resetAttempts,
	safeReturnTo,
	sessionCookie,
	clearSessionCookie,
} from '../src/http.ts';

describe('identity HTTP shape', () => {
	test('parses both issuer and mail-link paths', () => {
		expect(parseIdentityPath('/shop/.well-known/openid-configuration')).toEqual({ kind: 'discovery', poolId: 'shop' });
		expect(parseIdentityPath('/shop/.well-known/jwks.json')).toEqual({ kind: 'jwks', poolId: 'shop' });
		expect(parseIdentityPath('/shop/oauth2/authorize')).toEqual({ kind: 'oauth', poolId: 'shop', action: 'authorize' });
		expect(parseIdentityPath('/shop/oauth2/token')).toEqual({ kind: 'oauth', poolId: 'shop', action: 'token' });
		expect(parseIdentityPath('/shop/oauth2/userinfo')).toEqual({ kind: 'oauth', poolId: 'shop', action: 'userinfo' });
		expect(parseIdentityPath('/shop/oauth2/logout')).toEqual({ kind: 'oauth', poolId: 'shop', action: 'logout' });
		expect(parseIdentityPath('/shop/login')).toEqual({ kind: 'page', poolId: 'shop', page: 'login' });
		expect(parseIdentityPath('/shop')).toEqual({ kind: 'page', poolId: 'shop', page: 'login' });
		expect(parseIdentityPath('/pool/shop/magic')).toEqual({ kind: 'page', poolId: 'shop', page: 'magic' });
		expect(parseIdentityPath('/pool/shop/otp')).toEqual({ kind: 'page', poolId: 'shop', page: 'otp' });
		expect(parseIdentityPath('/shop/account')).toEqual({ kind: 'page', poolId: 'shop', page: 'account' });
		expect(parseIdentityPath('/pool/shop/.well-known/jwks.json')).toEqual({ kind: 'jwks', poolId: 'shop' });
	});

	test('parses passkey, social callback, health and metrics routes', () => {
		expect(parseIdentityPath('/shop/passkeys/login/options')).toEqual({ kind: 'passkey', poolId: 'shop', action: 'login-options' });
		expect(parseIdentityPath('/shop/passkeys/login/verify')).toEqual({ kind: 'passkey', poolId: 'shop', action: 'login-verify' });
		expect(parseIdentityPath('/shop/passkeys/register/options')).toEqual({ kind: 'passkey', poolId: 'shop', action: 'register-options' });
		expect(parseIdentityPath('/shop/passkeys/register/verify')).toEqual({ kind: 'passkey', poolId: 'shop', action: 'register-verify' });
		expect(parseIdentityPath('/shop/oauth/callback/github')).toEqual({ kind: 'socialCallback', poolId: 'shop', provider: 'github' });
		expect(parseIdentityPath('/api/v1/user-pools/shop/oauth/callback/google')).toEqual({
			kind: 'socialCallback',
			poolId: 'shop',
			provider: 'google',
		});
		expect(parseIdentityPath('/health')).toEqual({ kind: 'health' });
		expect(parseIdentityPath('/healthz')).toEqual({ kind: 'health' });
		expect(parseIdentityPath('/readyz')).toEqual({ kind: 'ready' });
		expect(parseIdentityPath('/metrics')).toEqual({ kind: 'metrics' });
	});

	test('rejects unknown pages, actions and paths', () => {
		expect(parseIdentityPath('/shop/admin').kind).toBe('unknown');
		expect(parseIdentityPath('/shop/oauth2/device').kind).toBe('unknown');
		expect(parseIdentityPath('/shop/passkeys/other').kind).toBe('unknown');
		expect(parseIdentityPath('/shop/.well-known/other').kind).toBe('unknown');
		expect(parseIdentityPath('/').kind).toBe('unknown');
	});

	test('scopes the session and CSRF cookies to the pool path', () => {
		const cookie = sessionCookie('shop', 'tok_en', true);
		expect(cookie).toContain('skiff_pool_session=tok_en');
		expect(cookie).toContain('Path=/shop');
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('SameSite=Lax');
		expect(cookie).toContain('Secure');
		expect(clearSessionCookie('shop', false)).toContain('Max-Age=0');
		expect(clearSessionCookie('shop', false)).not.toContain('Secure');
		const csrf = csrfCookie('shop', 'csrf-token', true);
		expect(csrf).toContain('skiff_pool_csrf=csrf-token');
		expect(csrf).toContain('Path=/shop');
		expect(csrf).toContain('Max-Age=900');
		expect(csrf).toContain('Secure');
	});

	test('reads a cookie out of a shared host header', () => {
		expect(cookieValue('a=1; skiff_pool_session=tok%2Fen; b=2', 'skiff_pool_session')).toBe('tok/en');
		expect(cookieValue('a=1', 'skiff_pool_session')).toBeNull();
	});

	test('only same-site return paths are accepted', () => {
		expect(safeReturnTo('/shop/login', '/fallback')).toBe('/shop/login');
		expect(safeReturnTo('https://evil.example', '/fallback')).toBe('/fallback');
		expect(safeReturnTo('//evil.example', '/fallback')).toBe('/fallback');
		expect(safeReturnTo('/shop\\evil', '/fallback')).toBe('/fallback');
		expect(safeReturnTo(null, '/fallback')).toBe('/fallback');
		// The authorize URL is absolute on the issuer host; it is the normal post-login target.
		expect(safeReturnTo('https://auth.example.com/shop/oauth2/authorize?x=1', '/fallback', 'https://auth.example.com')).toBe(
			'https://auth.example.com/shop/oauth2/authorize?x=1',
		);
		expect(safeReturnTo('https://other.example.com/x', '/fallback', 'https://auth.example.com')).toBe('/fallback');
	});

	test('takes client credentials from Basic or the form', () => {
		const basic = `Basic ${btoa('client:secret')}`;
		expect(clientCredentials(basic, new URLSearchParams())).toEqual({ clientId: 'client', clientSecret: 'secret' });
		expect(clientCredentials(null, new URLSearchParams({ client_id: 'c', client_secret: 's' }))).toEqual({
			clientId: 'c',
			clientSecret: 's',
		});
		expect(clientCredentials(null, new URLSearchParams({ client_id: 'public' }))).toEqual({
			clientId: 'public',
			clientSecret: null,
		});
	});

	test('builds issuer paths without a leading double slash', () => {
		expect(poolPath('shop')).toBe('/shop');
		expect(poolPath('shop', 'login')).toBe('/shop/login');
	});

	test('themes a hosted page with pool colours and display name', async () => {
		const response = renderPage({
			poolName: 'Shop',
			title: 'Sign in',
			body: '<h1>Sign in</h1>',
			theme: { displayName: 'Shop Auth', primaryColor: '#2563eb', backgroundColor: '#f8fafc' },
		});
		const html = await response.text();
		expect(html).toContain('Shop Auth');
		expect(html).toContain('--pool-primary: #2563eb');
		expect(html).toContain('background: #f8fafc');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('x-frame-options')).toBe('DENY');
	});

	test('rate limits a rolling window and resets for tests', () => {
		resetAttempts();
		expect(allowAttempt('login:shop:a@example.com', 2)).toBe(true);
		expect(allowAttempt('login:shop:a@example.com', 2)).toBe(true);
		expect(allowAttempt('login:shop:a@example.com', 2)).toBe(false);
		expect(allowAttempt('login:shop:b@example.com', 2)).toBe(true);
		resetAttempts();
		expect(allowAttempt('login:shop:a@example.com', 2)).toBe(true);
	});
});

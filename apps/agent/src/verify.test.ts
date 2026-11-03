import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { desiredStateSchema, type DesiredState } from '@skiff/contracts';
import {
	handleSiteRequest,
	hmacBase64url,
	normalizeHost,
	readCookie,
	signVisitorCookie,
} from './verify.ts';

const NOW = 1_800_000_000;
const SITE_KEY = 'site-key-0123456789';
const HOST = 'secret.example.com';
const LOGIN = 'https://cloud.example.com/_skiff/site-login?project=prj_1';

function state(): DesiredState {
	return desiredStateSchema.parse({
		version: 7,
		nodeId: 'nod_1',
		agentVersion: '0.1.0',
		generatedAt: new Date(NOW * 1000).toISOString(),
		contentDomain: 'example.com',
		releases: [{ sha256: 'a'.repeat(64), url: null, sizeBytes: 10, fileCount: 1, precompressed: true }],
		routes: [
			{
				projectId: 'prj_1',
				slug: 'secret',
				host: HOST,
				deploymentId: 'dep_1',
				release: 'a'.repeat(64),
				access: { mode: 'password', siteKey: SITE_KEY, loginUrl: LOGIN },
				accessMode: 'password',
				spa: false,
				cleanUrls: false,
				trailingSlash: 'ignore',
				notFound: null,
				redirects: [],
				headers: [],
			},
		],
		revocations: [],
		hostRedirects: [],
	});
}

function verifyRequest(headers: Record<string, string>): Request {
	return new Request('http://agent.local/_skiff/verify', { headers });
}

function token(claims: Record<string, unknown>, key = SITE_KEY): string {
	const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
	const signature = createHmac('sha256', key).update(payload).digest('base64url');
	return `${payload}.${signature}`;
}

const options = {
	state: state(),
	cookieName: '__skiff_s',
	insecureHttp: false,
	nowSeconds: () => NOW,
};

describe('visitor cookies', () => {
	test('accepts a valid host-only cookie', () => {
		const exp = NOW + 3600;
		const cookie = `${exp}.${signVisitorCookie(SITE_KEY, HOST, exp)}`;
		const response = handleSiteRequest(
			verifyRequest({
				'x-forwarded-host': HOST,
				'x-forwarded-uri': '/page?x=1',
				cookie: `other=1; __skiff_s=${cookie}; another=2`,
			}),
			options,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('x-skiff-visitor')).toBe(String(exp));
		expect(response.headers.get('x-skiff-project')).toBe('prj_1');
	});

	test('rejects a forged signature and redirects with an encoded return URL', () => {
		const exp = NOW + 3600;
		const response = handleSiteRequest(
			verifyRequest({
				'x-forwarded-host': HOST,
				'x-forwarded-uri': '/page?x=1',
				cookie: `__skiff_s=${exp}.forged`,
			}),
			options,
		);
		expect(response.status).toBe(302);
		const location = response.headers.get('location');
		expect(location).not.toBeNull();
		const url = new URL(location!);
		expect(url.origin + url.pathname).toBe('https://cloud.example.com/_skiff/site-login');
		expect(url.searchParams.get('project')).toBe('prj_1');
		expect(url.searchParams.get('return')).toBe('https://secret.example.com/page?x=1');
	});

	test('rejects an expired cookie', () => {
		const exp = NOW - 1;
		const response = handleSiteRequest(
			verifyRequest({
				'x-forwarded-host': HOST,
				cookie: `__skiff_s=${exp}.${signVisitorCookie(SITE_KEY, HOST, exp)}`,
			}),
			options,
		);
		expect(response.status).toBe(302);
	});

	test('rejects a cookie minted for another host', () => {
		const exp = NOW + 3600;
		const response = handleSiteRequest(
			verifyRequest({
				'x-forwarded-host': HOST,
				cookie: `__skiff_s=${exp}.${signVisitorCookie(SITE_KEY, 'other.example.com', exp)}`,
			}),
			options,
		);
		expect(response.status).toBe(302);
	});

	test('unknown host is a 404', () => {
		const response = handleSiteRequest(
			verifyRequest({ 'x-forwarded-host': 'unknown.example.com' }),
			options,
		);
		expect(response.status).toBe(404);
	});

	test('falls back to the Host header when X-Forwarded-Host is absent', () => {
		const exp = NOW + 3600;
		const response = handleSiteRequest(
			new Request('http://agent.local/_skiff/verify', {
				headers: { host: HOST, cookie: `__skiff_s=${exp}.${signVisitorCookie(SITE_KEY, HOST, exp)}` },
			}),
			options,
		);
		expect(response.status).toBe(200);
	});

	test('rejects a cookie for a revoked share session', () => {
		const exp = NOW + 3600;
		const cookie = `${exp}.red_1.${signVisitorCookie(SITE_KEY, HOST, exp, 'red_1')}`;
		const withRevocation = state();
		withRevocation.revocations = [
			{ id: 'red_1', kind: 'session', revokedAt: new Date(NOW * 1000).toISOString() },
		];
		const response = handleSiteRequest(
			verifyRequest({
				'x-forwarded-host': HOST,
				'x-forwarded-uri': '/',
				cookie: `__skiff_s=${cookie}`,
			}),
			{ ...options, state: withRevocation },
		);
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toContain('/_skiff/site-login');
	});

	test('dev mode uses http return URLs without Secure cookies', () => {
		const exp = NOW + 60;
		const missingCookie = handleSiteRequest(
			verifyRequest({ 'x-forwarded-host': HOST, 'x-forwarded-uri': '/a' }),
			{ ...options, insecureHttp: true },
		);
		expect(new URL(missingCookie.headers.get('location')!).searchParams.get('return')).toBe(
			`http://${HOST}/a`,
		);

		const callback = handleSiteRequest(
			new Request(
				`http://agent.local/_skiff/callback?token=${token({
					host: HOST,
					exp,
					sub: 'usr_1',
					kind: 'platform',
					sid: 'ses_1',
				})}`,
				{ headers: { 'x-forwarded-host': HOST } },
			),
			{ ...options, insecureHttp: true },
		);
		expect(callback.headers.get('set-cookie')).not.toContain('Secure');
	});
});

describe('login callback', () => {
	test('exchanges a signed token for a host-only cookie', () => {
		const exp = NOW + 120;
		const signed = token({ host: HOST, exp, sub: 'usr_1', kind: 'platform', sid: 'ses_1' });
		const response = handleSiteRequest(
			new Request(`http://agent.local/_skiff/callback?token=${signed}`, {
				headers: { 'x-forwarded-host': HOST },
			}),
			options,
		);
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('/');
		const cookie = response.headers.get('set-cookie') ?? '';
		const expected = `${exp}.ses_1.${signVisitorCookie(SITE_KEY, HOST, exp, 'ses_1')}`;
		expect(cookie).toContain(`__skiff_s=${expected}`);
		expect(cookie).toContain('Path=/');
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('Secure');
		expect(cookie).toContain('SameSite=Lax');
		expect(cookie).toContain(`Max-Age=${exp - NOW}`);
	});

	test('works through forward_auth using X-Forwarded-Uri', () => {
		const exp = NOW + 120;
		const signed = token({ host: HOST, exp, sub: 'usr_2', kind: 'password' });
		const response = handleSiteRequest(
			verifyRequest({
				'x-forwarded-host': HOST,
				'x-forwarded-uri': `/_skiff/callback?token=${signed}`,
			}),
			options,
		);
		expect(response.status).toBe(302);
		expect(response.headers.get('set-cookie')).toContain('__skiff_s=');
	});

	test('rejects a token for a different host', () => {
		const signed = token({ host: 'other.example.com', exp: NOW + 120, sub: 'usr_1', kind: 'platform' });
		const response = handleSiteRequest(
			new Request(`http://agent.local/_skiff/callback?token=${signed}`, {
				headers: { 'x-forwarded-host': HOST },
			}),
			options,
		);
		expect(response.status).toBe(404);
	});

	test('rejects a bad signature', () => {
		const signed = token({ host: HOST, exp: NOW + 120, sub: 'usr_1', kind: 'platform' }, 'wrong-site-key-000');
		const response = handleSiteRequest(
			new Request(`http://agent.local/_skiff/callback?token=${signed}`, {
				headers: { 'x-forwarded-host': HOST },
			}),
			options,
		);
		expect(response.status).toBe(403);
	});

	test('rejects an expired token', () => {
		const signed = token({ host: HOST, exp: NOW - 1, sub: 'usr_1', kind: 'platform' });
		const response = handleSiteRequest(
			new Request(`http://agent.local/_skiff/callback?token=${signed}`, {
				headers: { 'x-forwarded-host': HOST },
			}),
			options,
		);
		expect(response.status).toBe(403);
	});

	test('rejects a malformed token', () => {
		const response = handleSiteRequest(
			new Request('http://agent.local/_skiff/callback?token=nope', {
				headers: { 'x-forwarded-host': HOST },
			}),
			options,
		);
		expect(response.status).toBe(400);
	});
});

describe('helpers', () => {
	test('normalizes hosts and ports', () => {
		expect(normalizeHost('Secret.Example.COM:443')).toBe('secret.example.com');
		expect(normalizeHost('secret.example.com.')).toBe('secret.example.com');
		expect(normalizeHost('[::1]:443')).toBe('[::1]');
		expect(normalizeHost('bad host')).toBe('');
	});

	test('parses cookies without matching prefixes', () => {
		expect(readCookie('a=1; __skiff_s=two; __skiff_sx=three', '__skiff_s')).toBe('two');
		expect(readCookie(null, '__skiff_s')).toBeNull();
	});

	test('HMAC output is base64url', () => {
		expect(hmacBase64url(SITE_KEY, 'x')).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});

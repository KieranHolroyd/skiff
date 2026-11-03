import { describe, expect, test } from 'bun:test';
import { checkCsrf } from './csrf.ts';

const ORIGIN = 'https://cloud.example.com';
const req = (method: string, path: string, headers: Record<string, string> = {}) => {
	const url = new URL(path, ORIGIN);
	return [new Request(url, { method, headers }), url] as const;
};

describe('checkCsrf', () => {
	test('safe methods always pass', () => {
		expect(checkCsrf(...req('GET', '/projects'), ORIGIN).ok).toBe(true);
	});

	test('same-origin mutation passes', () => {
		expect(checkCsrf(...req('POST', '/api/auth/sign-in/email', { origin: ORIGIN }), ORIGIN).ok).toBe(true);
	});

	test('cross-origin mutation is blocked', () => {
		expect(checkCsrf(...req('POST', '/api/auth/oauth2/consent', { origin: 'https://evil.example' }), ORIGIN).ok).toBe(false);
	});

	test('deployed content on a sibling subdomain is cross-origin', () => {
		expect(checkCsrf(...req('POST', '/projects/x/delete', { origin: 'https://evil.example.com' }), ORIGIN).ok).toBe(false);
	});

	test('missing Origin without same-origin fetch metadata is blocked', () => {
		expect(checkCsrf(...req('POST', '/api/auth/sign-out'), ORIGIN).ok).toBe(false);
		expect(checkCsrf(...req('POST', '/api/auth/sign-out', { 'sec-fetch-site': 'cross-site' }), ORIGIN).ok).toBe(false);
		expect(checkCsrf(...req('POST', '/api/auth/sign-out', { 'sec-fetch-site': 'same-origin' }), ORIGIN).ok).toBe(true);
	});

	test('cookieless OAuth/MCP endpoints accept cross-origin calls', () => {
		for (const path of ['/api/auth/oauth2/token', '/api/auth/oauth2/register', '/mcp'])
			expect(checkCsrf(...req('POST', path, { origin: 'https://claude.ai' }), ORIGIN).ok).toBe(true);
	});

	test('allowlist is exact, not a prefix', () => {
		expect(checkCsrf(...req('POST', '/api/auth/oauth2/token-evil'), ORIGIN).ok).toBe(false);
		expect(checkCsrf(...req('POST', '/mcp/admin'), ORIGIN).ok).toBe(false);
	});

	test('cookieless prefixes cover only their own subtree', () => {
		expect(checkCsrf(...req('POST', '/api/agent/heartbeat', { origin: 'https://evil.example' }), ORIGIN).ok).toBe(true);
		for (const path of ['/api/agentx', '/api/v1/site-access', '/api/v1/site-access-evil'])
			expect(checkCsrf(...req('POST', path, { origin: 'https://evil.example' }), ORIGIN).ok).toBe(false);
	});
});

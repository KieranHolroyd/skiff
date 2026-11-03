import { describe, expect, test } from 'bun:test';
import { authErrorMessage, providerLabel, toIso, toSessionSummaries } from './user-settings.ts';

const session = (overrides: Partial<Parameters<typeof toSessionSummaries>[0][number]>) => ({
	id: 'session-1',
	token: 'secret-token',
	createdAt: new Date('2026-01-01T10:00:00.000Z'),
	updatedAt: new Date('2026-01-03T10:00:00.000Z'),
	expiresAt: new Date('2027-02-01T10:00:00.000Z'),
	ipAddress: '203.0.113.7',
	userAgent:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
	...overrides
});

describe('toSessionSummaries', () => {
	test('never exposes the session token', () => {
		const [summary] = toSessionSummaries([session({})], 'session-1');
		expect(summary).toBeDefined();
		expect(Object.keys(summary!)).not.toContain('token');
	});

	test('puts the current session first, then most recently active', () => {
		const summaries = toSessionSummaries(
			[
				session({ id: 'old', updatedAt: new Date('2026-01-02T10:00:00.000Z') }),
				session({ id: 'current', updatedAt: new Date('2026-01-01T10:00:00.000Z') }),
				session({ id: 'newer', updatedAt: new Date('2026-01-04T10:00:00.000Z') })
			],
			'current'
		);
		expect(summaries.map((summary) => summary.id)).toEqual(['current', 'newer', 'old']);
		expect(summaries[0]?.current).toBe(true);
		expect(summaries[0]?.device).toBe('Chrome on macOS');
	});

	test('omits expired sessions', () => {
		const summaries = toSessionSummaries(
			[
				session({ id: 'live' }),
				session({ id: 'expired', expiresAt: new Date('2025-12-01T10:00:00.000Z') })
			],
			null,
			Date.parse('2026-01-05T00:00:00.000Z')
		);
		expect(summaries.map((summary) => summary.id)).toEqual(['live']);
	});

	test('keeps unknown expiry visible and handles missing metadata', () => {
		const summaries = toSessionSummaries(
			[session({ token: 'x', expiresAt: '', ipAddress: null, userAgent: null })],
			null
		);
		expect(summaries[0]?.expiresAt).toBeNull();
		expect(summaries[0]?.ipAddress).toBeNull();
		expect(summaries[0]?.device).toBe('Unknown device');
	});
});

describe('toIso', () => {
	test('normalises dates and rejects invalid values', () => {
		expect(toIso(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01T00:00:00.000Z');
		expect(toIso(0)).toBe('1970-01-01T00:00:00.000Z');
		expect(toIso('not-a-date')).toBeNull();
		expect(toIso(null)).toBeNull();
	});
});

describe('providerLabel', () => {
	test('labels known auth providers', () => {
		expect(providerLabel('github')).toBe('GitHub');
		expect(providerLabel('credential')).toBe('Email & password');
		expect(providerLabel('saml')).toBe('saml');
	});
});

describe('authErrorMessage', () => {
	test('prefers the Better Auth body message', () => {
		expect(authErrorMessage({ body: { message: 'Email already in use' }, message: 'nope' })).toBe(
			'Email already in use'
		);
	});

	test('falls back to Error.message and then a generic message', () => {
		expect(authErrorMessage(new Error('Session expired'))).toBe('Session expired');
		expect(authErrorMessage({})).toBe('The auth service rejected the request. Please try again.');
	});
});

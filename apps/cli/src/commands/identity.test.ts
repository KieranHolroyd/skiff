import { describe, expect, test } from 'bun:test';
import {
	WORKLOAD_IDENTITY_AUDIENCE,
	WORKLOAD_IDENTITY_TOKEN_FILE,
	WORKLOAD_IDENTITY_URL,
	identityMetadataUrl,
	identityTokenPath,
	jwtRemainingSeconds,
	parseAudience,
	parseIdentityTokenResponse,
} from './identity.ts';

describe('parseAudience', () => {
	test('defaults to skiff and trims a supplied audience', () => {
		expect(parseAudience(undefined)).toBe(WORKLOAD_IDENTITY_AUDIENCE);
		expect(parseAudience('  sts.amazonaws.com  ')).toBe('sts.amazonaws.com');
		expect(parseAudience('api://AzureADTokenExchange')).toBe('api://AzureADTokenExchange');
	});

	test('rejects a control character and an over-long audience', () => {
		expect(() => parseAudience('bad\u0000audience')).toThrow();
		expect(() => parseAudience('a'.repeat(513))).toThrow();
		expect(parseAudience('a'.repeat(512))).toHaveLength(512);
	});
});

describe('identityTokenPath', () => {
	test('flag wins over the environment and the mount default', () => {
		expect(
			identityTokenPath('  /tmp/token  ', { SKIFF_TOKEN_FILE: '/run/skiff/token' }),
		).toBe('/tmp/token');
	});

	test('falls back to SKIFF_TOKEN_FILE, then the fixed mount path', () => {
		expect(identityTokenPath(undefined, { SKIFF_TOKEN_FILE: '  /tmp/env-token  ' })).toBe(
			'/tmp/env-token',
		);
		expect(identityTokenPath(undefined, {})).toBe(WORKLOAD_IDENTITY_TOKEN_FILE);
		expect(identityTokenPath('   ', { SKIFF_TOKEN_FILE: '/tmp/env-token' })).toBe(
			'/tmp/env-token',
		);
	});
});

describe('identityMetadataUrl', () => {
	test('flag wins over the environment and the loopback default', () => {
		expect(
			identityMetadataUrl('  http://127.0.0.1:9999/  ', {
				SKIFF_IDENTITY_URL: 'http://10.0.2.2:8086',
			}),
		).toBe('http://127.0.0.1:9999');
	});

	test('falls back to SKIFF_IDENTITY_URL, then loopback', () => {
		expect(identityMetadataUrl(undefined, { SKIFF_IDENTITY_URL: 'http://10.0.2.2:8086/' })).toBe(
			'http://10.0.2.2:8086',
		);
		expect(identityMetadataUrl(undefined, {})).toBe(WORKLOAD_IDENTITY_URL);
	});

	test('refuses a non-http protocol and a non-URL', () => {
		expect(() => identityMetadataUrl('ftp://example.com')).toThrow();
		expect(() => identityMetadataUrl('not a url')).toThrow();
	});
});

describe('jwtRemainingSeconds', () => {
	const at = Date.UTC(2026, 10, 9, 12, 0, 0);
	const jwt = (claims: Record<string, unknown>) =>
		`header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

	test('reads exp and never goes below zero', () => {
		expect(jwtRemainingSeconds(jwt({ exp: at / 1000 + 120 }), at)).toBe(120);
		expect(jwtRemainingSeconds(jwt({ exp: at / 1000 - 120 }), at)).toBe(0);
	});

	test('returns null for a missing exp or an unreadable payload', () => {
		expect(jwtRemainingSeconds(jwt({ sub: 'sa_1' }), at)).toBeNull();
		expect(jwtRemainingSeconds('header.%%%.signature', at)).toBeNull();
		expect(jwtRemainingSeconds('not-a-jwt', at)).toBeNull();
	});
});

describe('parseIdentityTokenResponse', () => {
	test('keeps the token, expiry and type', () => {
		expect(
			parseIdentityTokenResponse({
				access_token: 'eyJ.header.signature',
				expires_in: 3600,
				token_type: 'Bearer',
			}),
		).toEqual({
			access_token: 'eyJ.header.signature',
			expires_in: 3600,
			token_type: 'Bearer',
		});
	});

	test('defaults the type and refuses a response without a token', () => {
		expect(
			parseIdentityTokenResponse({ access_token: 'eyJ.header.signature' }),
		).toMatchObject({ token_type: 'Bearer', expires_in: 0 });
		expect(() => parseIdentityTokenResponse({ expires_in: 3600 })).toThrow();
		expect(() => parseIdentityTokenResponse(null)).toThrow();
	});
});

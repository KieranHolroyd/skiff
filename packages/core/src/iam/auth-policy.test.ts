import { describe, expect, test } from 'bun:test';
import {
	AUTH_METHODS,
	defaultAuthPolicy,
	isIpv4Cidr,
	normalizeAuthPolicy,
} from './auth-policy.ts';

describe('org auth policy validation', () => {
	test('defaults allow every method and set no limits', () => {
		const policy = defaultAuthPolicy('org_1');
		expect(policy.allowedMethods).toEqual([...AUTH_METHODS]);
		expect(policy.sessionMaxAge).toBeNull();
		expect(policy.idleTimeout).toBeNull();
		expect(policy.ipAllowlist).toEqual([]);
	});

	test('normalises additive updates without dropping unchanged values', () => {
		const base = { ...defaultAuthPolicy('org_1'), require2fa: true };
		const policy = normalizeAuthPolicy('org_1', { sessionMaxAge: 3600 }, base);
		expect(policy.require2fa).toBe(true);
		expect(policy.sessionMaxAge).toBe(3600);
	});

	test('refuses an empty method list', () => {
		expect(() => normalizeAuthPolicy('org_1', { allowedMethods: [] })).toThrow();
	});

	test('refuses a duplicate or unknown method', () => {
		expect(() =>
			normalizeAuthPolicy('org_1', { allowedMethods: ['password', 'password'] })
		).not.toThrow();
		expect(() =>
			normalizeAuthPolicy('org_1', {
				allowedMethods: ['password', 'sms' as never],
			})
		).toThrow();
	});

	test('requires a break-glass owner when SSO is required', () => {
		expect(() => normalizeAuthPolicy('org_1', { requireSso: true })).toThrow();
		expect(() =>
			normalizeAuthPolicy('org_1', {
				requireSso: true,
				breakGlassUserIds: ['usr_owner'],
			})
		).not.toThrow();
	});

	test('idle timeout cannot exceed the maximum session age', () => {
		expect(() =>
			normalizeAuthPolicy('org_1', { sessionMaxAge: 3600, idleTimeout: 7200 })
		).toThrow();
	});

	test('IPv4 CIDR validation accepts addresses, rejects malformed values', () => {
		expect(isIpv4Cidr('10.0.0.0/8')).toBe(true);
		expect(isIpv4Cidr('203.0.113.7')).toBe(true);
		expect(isIpv4Cidr('10.0.0.0/33')).toBe(false);
		expect(isIpv4Cidr('not-a-cidr')).toBe(false);
	});
});

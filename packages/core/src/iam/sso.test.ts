import { describe, expect, test } from 'bun:test';
import {
	SSO_RECHECK_MS,
	SSO_VERIFY_PREFIX,
	emailDomain,
	hasSsoVerificationRecord,
	normalizeSsoDomain,
	ssoDomainCheckDue,
	ssoVerificationRecord,
	verifiedDomainForEmail,
} from './sso.ts';

describe('normalizeSsoDomain', () => {
	test('lowercases, trims and drops a trailing dot', () => {
		expect(normalizeSsoDomain('  Example.COM. ')).toBe('example.com');
	});

	test('accepts a delegated subdomain and an international-looking TLD', () => {
		expect(normalizeSsoDomain('login.eu.example.co.uk')).toBe('login.eu.example.co.uk');
	});

	test('rejects schemes, paths, ports, emails and wildcards', () => {
		for (const value of [
			'https://example.com',
			'example.com/login',
			'example.com:443',
			'user@example.com',
			'*.example.com',
			'localhost',
			'127.0.0.1',
			'',
		])
			expect(normalizeSsoDomain(value)).toBeNull();
	});
});

describe('emailDomain', () => {
	test('returns the lowercased domain', () => {
		expect(emailDomain('Ada@Example.COM')).toBe('example.com');
	});

	test('handles a plus address and the last at-sign only', () => {
		expect(emailDomain('ada+skiff@mail.example.com')).toBe('mail.example.com');
	});

	test('rejects anything without exactly one local part and domain', () => {
		for (const value of ['', 'ada', '@example.com', 'ada@', 'a@b@example.com', 'ada@localhost'])
			expect(emailDomain(value)).toBeNull();
	});
});

describe('verifiedDomainForEmail', () => {
	const domains = [
		{ domain: 'example.com', verifiedAt: null },
		{ domain: 'mail.example.com', verifiedAt: 1 },
	];

	test('only a verified row routes', () => {
		expect(verifiedDomainForEmail('ada@example.com', domains)).toBeNull();
		expect(verifiedDomainForEmail('ada@mail.example.com', domains)).toEqual(domains[1]!);
	});

	test('matching is exact, never a suffix', () => {
		expect(verifiedDomainForEmail('ada@sub.mail.example.com', domains)).toBeNull();
		expect(verifiedDomainForEmail('ada@evil-example.com', domains)).toBeNull();
	});

	test('a bad address routes nowhere', () => {
		expect(verifiedDomainForEmail('ada', domains)).toBeNull();
	});
});

describe('verification record', () => {
	test('uses the skiff-verify prefix', () => {
		expect(SSO_VERIFY_PREFIX).toBe('skiff-verify=');
		expect(ssoVerificationRecord('  abc123 ')).toBe('skiff-verify=abc123');
	});

	test('joins a record split into character-strings', () => {
		expect(hasSsoVerificationRecord([['skiff-verify=', 'abc123']], 'abc123')).toBe(true);
	});

	test('ignores other TXT records and other tokens', () => {
		expect(
			hasSsoVerificationRecord(
				[['v=spf1 -all'], ['skiff-verify=other'], ['not-skiff-verify=abc123']],
				'abc123',
			),
		).toBe(false);
		expect(hasSsoVerificationRecord([], 'abc123')).toBe(false);
	});
});

describe('ssoDomainCheckDue', () => {
	test('a never-checked row is due', () => {
		expect(ssoDomainCheckDue(null, 0)).toBe(true);
	});

	test('a row is due a day after its check', () => {
		const now = 100 * SSO_RECHECK_MS;
		expect(ssoDomainCheckDue(now - SSO_RECHECK_MS + 1, now)).toBe(false);
		expect(ssoDomainCheckDue(now - SSO_RECHECK_MS, now)).toBe(true);
	});
});

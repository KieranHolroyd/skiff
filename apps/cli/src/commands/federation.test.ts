import { describe, expect, test } from 'bun:test';
import {
	federationTable,
	parseClaimConditions,
	parseTtlSeconds,
	type FederationTrustView,
} from './federation.ts';

const trust: FederationTrustView = {
	id: 'ft_1',
	orgId: 'org_1',
	serviceAccountId: 'sa_1',
	issuer: 'https://token.actions.githubusercontent.com',
	audiences: ['https://control.test'],
	subjectPattern: 'repo:acme/web:ref:refs/heads/main',
	claimConditions: { ref: 'refs/heads/main' },
	maxTtlSeconds: 900,
	restriction: { permissions: ['project:read'] },
};

describe('parseClaimConditions', () => {
	test('turns key=value pairs into an object and keeps JSON types', () => {
		expect(
			parseClaimConditions([
				'ref=refs/heads/main',
				'repository=acme/web',
				'approved=true',
				'level=2',
			]),
		).toEqual({
			ref: 'refs/heads/main',
			repository: 'acme/web',
			approved: true,
			level: 2,
		});
	});

	test('rejects a pair without a key or equals sign', () => {
		expect(() => parseClaimConditions(['ref'])).toThrow(/key=value/);
		expect(() => parseClaimConditions(['=value'])).toThrow(/key=value/);
	});

	test('an empty value stays an empty string', () => {
		expect(parseClaimConditions(['ref='])).toEqual({ ref: '' });
	});
});

describe('parseTtlSeconds', () => {
	test('reads seconds, minutes and hours', () => {
		expect(parseTtlSeconds('30s')).toBe(30);
		expect(parseTtlSeconds('15m')).toBe(900);
		expect(parseTtlSeconds('1h')).toBe(3600);
	});

	test('refuses more than one hour and nonsense', () => {
		expect(() => parseTtlSeconds('2h')).toThrow(/one hour/);
		expect(() => parseTtlSeconds('90')).toThrow(/duration/);
		expect(() => parseTtlSeconds('0m')).toThrow(/positive/);
	});
});

describe('federationTable', () => {
	test('shows the issuer, audience, subject, account and cap', () => {
		const table = federationTable([trust]);
		expect(table).toContain('ft_1');
		expect(table).toContain('https://token.actions.githubusercontent.com');
		expect(table).toContain('https://control.test');
		expect(table).toContain('repo:acme/web:ref:refs/heads/main');
		expect(table).toContain('sa_1');
		expect(table).toContain('900s');
	});
});

import { describe, expect, test } from 'bun:test';
import {
	parseCidrs,
	parseTokenTtl,
	resolveServiceAccount,
	serviceAccountKeyTable,
	serviceAccountTable,
	type ServiceAccountKeyView,
	type ServiceAccountView,
} from './service-accounts.ts';

const ci: ServiceAccountView = {
	id: 'sa_1',
	name: 'ci-bot',
	description: 'GitHub Actions',
	ownerGroupId: null,
	disabled: false,
	disabledAt: null,
	createdBy: 'user_1',
	createdAt: Date.UTC(2026, 10, 8, 12, 0, 0),
};
const deploy: ServiceAccountView = {
	id: 'sa_2',
	name: 'deploy-bot',
	description: '',
	ownerGroupId: 'grp_eng',
	disabled: true,
	disabledAt: Date.UTC(2026, 10, 9, 12, 0, 0),
	createdBy: 'user_1',
	createdAt: Date.UTC(2026, 10, 9, 12, 0, 0),
};

describe('resolveServiceAccount', () => {
	test('resolves by id and by name', () => {
		expect(resolveServiceAccount([ci, deploy], 'sa_2')).toBe(deploy);
		expect(resolveServiceAccount([ci, deploy], 'ci-bot')).toBe(ci);
	});

	test('rejects an unknown account', () => {
		expect(() => resolveServiceAccount([ci], 'missing')).toThrow(/Unknown service account/);
	});

	test('prefers an exact id over a name', () => {
		const odd = { ...ci, id: 'deploy-bot', name: 'other' };
		expect(resolveServiceAccount([odd, deploy], 'deploy-bot').id).toBe('deploy-bot');
	});
});

describe('parseTokenTtl', () => {
	const now = Date.UTC(2026, 10, 9, 12, 0, 0);

	test('defaults to one hour', () => {
		expect(parseTokenTtl(undefined, now)).toBe(3600);
	});

	test('reads minutes and hours', () => {
		expect(parseTokenTtl('15m', now)).toBe(900);
		expect(parseTokenTtl('30m', now)).toBe(1800);
		expect(parseTokenTtl('1h', now)).toBe(3600);
	});

	test('refuses more than one hour and nonsense', () => {
		expect(() => parseTokenTtl('2h', now)).toThrow(/one hour/);
		expect(() => parseTokenTtl('soon', now)).toThrow();
	});
});

describe('parseCidrs', () => {
	test('splits commas and deduplicates', () => {
		expect(parseCidrs(['10.0.0.0/8, 192.168.0.0/16', '10.0.0.0/8'])).toEqual([
			'10.0.0.0/8',
			'192.168.0.0/16',
		]);
	});

	test('needs at least one network', () => {
		expect(() => parseCidrs([])).toThrow();
	});
});

describe('serviceAccountKeyTable', () => {
	test('shows the start, expiry, last use and state', () => {
		const keys: ServiceAccountKeyView[] = [
			{
				id: 'ak_1',
				name: 'ci',
				start: 'yoal_abc',
				expiresAt: Date.UTC(2026, 11, 1, 9, 0, 0),
				lastUsedAt: null,
				revokedAt: null,
			},
			{
				id: 'ak_2',
				name: 'old',
				start: 'yoal_def',
				expiresAt: null,
				lastUsedAt: Date.UTC(2026, 10, 9, 12, 0, 0),
				revokedAt: Date.UTC(2026, 10, 10, 12, 0, 0),
			},
		];
		const table = serviceAccountKeyTable(keys);
		expect(table).toContain('yoal_abc');
		expect(table).toContain('2026-12-01 09:00:00Z');
		expect(table).toContain('never');
		expect(table).toContain('2026-11-09 12:00:00Z');
		expect(table).toContain('active');
		expect(table).toContain('revoked');
	});
});

describe('serviceAccountTable', () => {
	test('shows the id, state, owner group and description', () => {
		const table = serviceAccountTable([ci, deploy]);
		expect(table).toContain('sa_1');
		expect(table).toContain('ci-bot');
		expect(table).toContain('active');
		expect(table).toContain('GitHub Actions');
		expect(table).toContain('disabled');
		expect(table).toContain('grp_eng');
	});

	test('an org-owned account shows org as the owner', () => {
		expect(serviceAccountTable([ci])).toContain('org');
	});

	test('an empty description prints a dash, not a blank cell', () => {
		expect(serviceAccountTable([deploy])).toContain('-');
	});
});

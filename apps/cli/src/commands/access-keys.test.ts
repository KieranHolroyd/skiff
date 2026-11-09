import { describe, expect, test } from 'bun:test';
import {
	accessKeyTable,
	parseCidrs,
	parseExpiresInSeconds,
	type AccessKeyView,
} from './access-keys.ts';

const active: AccessKeyView = {
	id: 'ak_1',
	orgId: 'org_1',
	principalType: 'serviceAccount',
	principalId: 'sa_1',
	name: 'ci',
	prefix: 'skif_',
	start: 'skif_abc',
	permissions: ['project:read'],
	resources: null,
	allowedCidrs: ['10.0.0.0/8'],
	expiresAt: Date.UTC(2026, 11, 1, 9, 0, 0),
	lastUsedAt: null,
	createdBy: 'user_1',
	revokedAt: null,
	createdAt: Date.UTC(2026, 10, 8, 12, 0, 0),
};
const revoked: AccessKeyView = {
	...active,
	id: 'ak_2',
	name: 'old',
	expiresAt: null,
	lastUsedAt: Date.UTC(2026, 10, 9, 12, 0, 0),
	revokedAt: Date.UTC(2026, 10, 10, 12, 0, 0),
};

describe('parseCidrs', () => {
	test('splits commas, trims and deduplicates', () => {
		expect(parseCidrs(['10.0.0.0/8, 192.168.0.0/16', '10.0.0.0/8'])).toEqual([
			'10.0.0.0/8',
			'192.168.0.0/16',
		]);
	});

	test('needs at least one network', () => {
		expect(() => parseCidrs([])).toThrow();
		expect(() => parseCidrs([' , '])).toThrow();
	});
});

describe('parseExpiresInSeconds', () => {
	const now = Date.UTC(2026, 10, 8, 12, 0, 0);

	test('turns the familiar durations into a TTL', () => {
		expect(parseExpiresInSeconds('30m', now)).toBe(1_800);
		expect(parseExpiresInSeconds('8h', now)).toBe(28_800);
		expect(parseExpiresInSeconds('90d', now)).toBe(90 * 86_400);
	});

	test('refuses nonsense and the past', () => {
		expect(() => parseExpiresInSeconds('soon', now)).toThrow();
		expect(() => parseExpiresInSeconds('2026-01-01T00:00:00Z', now)).toThrow();
	});
});

describe('accessKeyTable', () => {
	test('shows the principal, visible start, expiry and state', () => {
		const table = accessKeyTable([active, revoked]);
		expect(table).toContain('serviceAccount:sa_1');
		expect(table).toContain('skif_abc');
		expect(table).toContain('2026-12-01 09:00:00Z');
		expect(table).toContain('never');
		expect(table).toContain('revoked');
		expect(table).toContain('active');
	});

	test('shows last used, or never', () => {
		const table = accessKeyTable([active, revoked]);
		expect(table).toContain('2026-11-09 12:00:00Z');
		expect(table).toContain('never');
	});
});

import { describe, expect, test } from 'bun:test';
import {
	resolveServiceAccount,
	serviceAccountTable,
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

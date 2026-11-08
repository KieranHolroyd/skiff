import { describe, expect, test } from 'bun:test';
import {
	bindingTable,
	explainText,
	formatScope,
	groupTable,
	parseExpiry,
	parsePermissions,
	parsePrincipal,
	parseScope,
	roleTable,
	whoCanTable,
	type IamDecision,
	type IamRoleView,
} from './iam.ts';

const owner: IamRoleView = {
	id: 'owner',
	name: 'owner',
	description: 'Everything.',
	permissions: ['project:read', 'project:create', 'iam:read'],
	builtIn: true,
};
const billing: IamRoleView = {
	id: 'role_billing',
	name: 'billing',
	description: 'Billing views.',
	permissions: ['project:read'],
	builtIn: false,
};

describe('parseScope', () => {
	test('reads org, platform, project and environment scopes', () => {
		expect(parseScope('org')).toEqual({ type: 'org' });
		expect(parseScope('platform')).toEqual({ type: 'platform' });
		expect(parseScope('project:prj_1')).toEqual({ type: 'project', id: 'prj_1' });
		expect(parseScope('environment:prj_1/env_2')).toEqual({
			type: 'environment',
			projectId: 'prj_1',
			id: 'env_2',
		});
	});

	test('rejects a bare id or an incomplete environment', () => {
		expect(() => parseScope('prj_1')).toThrow();
		expect(() => parseScope('project:')).toThrow();
		expect(() => parseScope('environment:prj_1')).toThrow();
		expect(() => parseScope('environment:prj_1/')).toThrow();
	});
});

describe('formatScope', () => {
	test('round-trips every accepted scope', () => {
		for (const value of ['org', 'platform', 'project:prj_1', 'environment:prj_1/env_2'])
			expect(formatScope(parseScope(value))).toBe(value);
	});
});

describe('parsePrincipal', () => {
	test('splits the type from the id', () => {
		expect(parsePrincipal('user:user_abc')).toEqual({ principalType: 'user', principalId: 'user_abc' });
		expect(parsePrincipal('group:grp_eng')).toEqual({ principalType: 'group', principalId: 'grp_eng' });
		expect(parsePrincipal('serviceAccount:sa_ci')).toEqual({
			principalType: 'serviceAccount',
			principalId: 'sa_ci',
		});
	});

	test('rejects an unknown type or a missing id', () => {
		expect(() => parsePrincipal('robot:sa_ci')).toThrow();
		expect(() => parsePrincipal('user')).toThrow();
		expect(() => parsePrincipal(':user_abc')).toThrow();
	});
});

describe('parseExpiry', () => {
	const now = Date.UTC(2026, 10, 8, 12, 0, 0);

	test('adds a duration to now', () => {
		expect(parseExpiry('30m', now)).toBe(now + 30 * 60_000);
		expect(parseExpiry('8h', now)).toBe(now + 8 * 3_600_000);
		expect(parseExpiry('7d', now)).toBe(now + 7 * 86_400_000);
		expect(parseExpiry('2w', now)).toBe(now + 2 * 604_800_000);
	});

	test('accepts an ISO timestamp', () => {
		expect(parseExpiry('2026-12-01T09:00:00Z', now)).toBe(Date.UTC(2026, 11, 1, 9, 0, 0));
	});

	test('refuses nonsense and the past', () => {
		expect(() => parseExpiry('next tuesday', now)).toThrow();
		expect(() => parseExpiry('0h', now)).toThrow();
		expect(() => parseExpiry('2026-01-01T00:00:00Z', now)).toThrow();
	});
});

describe('parsePermissions', () => {
	test('repeats and commas become one deduplicated list', () => {
		expect(parsePermissions(['project:read', 'database:read,iam:read', 'project:read'])).toEqual([
			'project:read',
			'database:read',
			'iam:read',
		]);
	});

	test('needs at least one', () => {
		expect(() => parsePermissions([])).toThrow();
		expect(() => parsePermissions([' , '])).toThrow();
	});
});

describe('tables', () => {
	test('roles show built-in or custom and the permission count', () => {
		const table = roleTable([owner, billing]);
		expect(table).toContain('built-in');
		expect(table).toContain('custom');
		expect(table).toContain('billing');
		expect(table).toContain('3');
	});

	test('bindings show the role name, not its id, and never for no expiry', () => {
		const table = bindingTable(
			[
				{
					id: 'bind_1',
					principalType: 'group',
					principalId: 'grp_eng',
					roleId: 'role_billing',
					roleName: 'role_billing',
					scope: { type: 'project', id: 'prj_shop' },
					expiresAt: null,
					reason: null,
					createdBy: 'user_1',
					createdAt: Date.UTC(2026, 10, 8),
				},
				{
					id: 'bind_2',
					principalType: 'user',
					principalId: 'user_abc',
					roleId: 'owner',
					roleName: 'owner',
					scope: { type: 'org' },
					expiresAt: Date.UTC(2026, 11, 1, 9, 0, 0),
					reason: 'release week',
					createdBy: 'user_1',
					createdAt: Date.UTC(2026, 10, 8),
				},
			],
			[owner, billing],
		);
		expect(table).toContain('group:grp_eng');
		expect(table).toContain('billing');
		expect(table).toContain('project:prj_shop');
		expect(table).toContain('never');
		expect(table).toContain('2026-12-01 09:00:00Z');
	});

	test('groups show the member count', () => {
		const table = groupTable([
			{ id: 'grp_eng', name: 'eng', description: '', source: 'local', members: 3 },
		]);
		expect(table).toContain('grp_eng');
		expect(table).toContain('eng');
		expect(table).toContain('3');
		expect(table).toContain('local');
	});

	test('who-can shows each principal and the binding that allowed it', () => {
		const table = whoCanTable({
			permission: 'project:read',
			principals: [
				{ principalType: 'user', principalId: 'user_abc', via: 'bind_1' },
				{ principalType: 'group', principalId: 'grp_eng', via: null },
			],
		});
		expect(table).toContain('user:user_abc');
		expect(table).toContain('bind_1');
		expect(table).toContain('group:grp_eng');
	});
});

describe('explainText', () => {
	const decision: IamDecision = {
		allow: true,
		reason: 'binding',
		via: 'bind_2',
		chain: [
			{ bindingId: 'bind_1', roleId: 'role_billing', scope: { type: 'project', id: 'prj_other' }, outcome: 'scope' },
			{ bindingId: 'bind_2', roleId: 'owner', scope: { type: 'org' }, outcome: 'allow' },
		],
	};

	test('renders the decision, its reason, via and the whole chain', () => {
		const text = explainText(decision, 'project:read', { type: 'org' }, [owner, billing]);
		expect(text).toContain('Allowed  project:read on org');
		expect(text).toContain('Reason      binding');
		expect(text).toContain('Via         bind_2');
		expect(text).toContain('billing');
		expect(text).toContain('scope');
		expect(text).toContain('allow');
	});

	test('denials still show the chain', () => {
		const denied: IamDecision = {
			allow: false,
			reason: 'no-binding',
			chain: [],
		};
		const text = explainText(denied, 'database:credentials', { type: 'project', id: 'prj_1' }, [owner]);
		expect(text).toContain('Denied  database:credentials on project:prj_1');
		expect(text).toContain('No grant for this permission was considered.');
	});
});

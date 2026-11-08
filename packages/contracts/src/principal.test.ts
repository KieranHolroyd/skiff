import { describe, expect, test } from 'bun:test';
import {
	ForbiddenError,
	canAdministerPlatform,
	canViewPlatform,
	hasPermission,
	isHumanPrincipal,
	requirePermission,
	type Principal,
} from './principal.ts';
import type { Permission } from './permissions.ts';

function principal(overrides: Partial<Principal> = {}): Principal {
	return {
		kind: 'user',
		userId: 'usr_1',
		orgId: 'org_1',
		role: 'viewer',
		permissions: new Set<Permission>(['project:read']),
		...overrides,
	};
}

describe('principal v2', () => {
	test('machine kinds are not human', () => {
		for (const kind of ['serviceAccount', 'workload', 'job', 'node', 'system'] as const)
			expect(isHumanPrincipal(principal({ kind }))).toBe(false);
		for (const kind of ['user', 'apiKey', 'mcp'] as const)
			expect(isHumanPrincipal(principal({ kind }))).toBe(true);
	});

	test('a machine carries the credential it used and who it acts for', () => {
		const job = principal({
			kind: 'job',
			userId: 'job_1',
			credential: 'job',
			actingFor: { kind: 'user', id: 'usr_1' },
		});
		expect(job.credential).toBe('job');
		expect(job.actingFor).toEqual({ kind: 'user', id: 'usr_1' });
	});

	test('new machine kinds never get platform access by accident', () => {
		for (const kind of ['serviceAccount', 'workload', 'job', 'node'] as const) {
			expect(canViewPlatform(principal({ kind }))).toBe(false);
			expect(canAdministerPlatform(principal({ kind }))).toBe(false);
		}
	});

	test('platform mutations stay session-only', () => {
		expect(canAdministerPlatform(principal({ platformAdmin: true }))).toBe(true);
		expect(canAdministerPlatform(principal({ platformAdmin: true, kind: 'apiKey' }))).toBe(false);
		expect(canAdministerPlatform(principal({ platformAdmin: true, kind: 'mcp' }))).toBe(false);
	});

	test('requirePermission fails closed', () => {
		expect(hasPermission(principal(), 'project:read')).toBe(true);
		expect(() => requirePermission(principal(), 'project:delete')).toThrow(ForbiddenError);
	});
});

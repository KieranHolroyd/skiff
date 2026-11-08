import { describe, expect, test } from 'bun:test';
import {
	ForbiddenError,
	STEP_UP_WINDOW_MS,
	StepUpRequiredError,
	canAdministerPlatform,
	canViewPlatform,
	hasPermission,
	isHumanPrincipal,
	requirePermission,
	requireStepUp,
	stepUpLevel,
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

describe('step-up', () => {
	const now = Date.parse('2026-11-08T12:00:00Z');

	test('level comes from the catalog', () => {
		expect(stepUpLevel('project:read')).toBe('none');
		expect(stepUpLevel('database:credentials')).toBe('window');
		expect(stepUpLevel('org:delete')).toBe('always');
	});

	test('none needs no verification', () => {
		expect(() => requireStepUp(principal(), 'project:read', now)).not.toThrow();
	});

	test('window accepts a fresh verification of the strongest class', () => {
		const verified = principal({
			verification: { at: now - 60_000, class: 'strong', strongest: 'strong' },
		});
		expect(() => requireStepUp(verified, 'database:credentials', now)).not.toThrow();

		const basicOnly = principal({
			verification: { at: now - 60_000, class: 'basic', strongest: 'basic' },
		});
		expect(() => requireStepUp(basicOnly, 'database:credentials', now)).not.toThrow();
	});

	test('window expires, and a basic verification is not enough once a strong factor exists', () => {
		expect(() =>
			requireStepUp(principal(), 'database:credentials', now),
		).toThrow(StepUpRequiredError);

		expect(() =>
			requireStepUp(
				principal({
					verification: { at: now - STEP_UP_WINDOW_MS, class: 'strong', strongest: 'strong' },
				}),
				'database:credentials',
				now,
			),
		).toThrow(StepUpRequiredError);

		expect(() =>
			requireStepUp(
				principal({
					verification: { at: now - 60_000, class: 'basic', strongest: 'strong' },
				}),
				'database:credentials',
				now,
			),
		).toThrow(StepUpRequiredError);
	});

	test('always asks every time, even after a fresh verification', () => {
		expect(() =>
			requireStepUp(
				principal({
					verification: { at: now - 60_000, class: 'strong', strongest: 'strong' },
				}),
				'org:delete',
				now,
			),
		).toThrow(StepUpRequiredError);
	});
});

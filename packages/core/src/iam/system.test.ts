import { describe, expect, test } from 'bun:test';
import { roles, systemPermissions } from '@skiff/contracts';
import { buildSystemPrincipal } from './system.ts';

describe('buildSystemPrincipal', () => {
	test('builds a named system principal without owner permissions', () => {
		const principal = buildSystemPrincipal('system:pipeline-deploy', 'org_1');
		expect(principal.kind).toBe('system');
		expect(principal.userId).toBe('system:pipeline-deploy');
		expect(principal.orgId).toBe('org_1');
		expect(principal.role).not.toBe('owner');
		expect(principal.platformAdmin).toBe(false);
		expect(principal.credential).toBe('system');
		expect([...principal.permissions].sort()).toEqual([...systemPermissions('system:pipeline-deploy')].sort());
		expect(principal.permissions.size).toBeLessThan(roles.owner.length);
		expect(principal.permissions.has('org:delete')).toBe(false);
		expect(principal.permissions.has('org:transfer')).toBe(false);
		expect(principal.permissions.has('iam:manage-owners')).toBe(false);
	});

	test('carries actingFor and accepts an explicit credential', () => {
		const actingFor = { kind: 'user' as const, id: 'user_1' };
		const principal = buildSystemPrincipal('system:pipeline-deploy', 'org_1', {
			actingFor,
			credential: 'system',
		});
		expect(principal.actingFor).toEqual(actingFor);
		expect(principal.credential).toBe('system');
	});
});

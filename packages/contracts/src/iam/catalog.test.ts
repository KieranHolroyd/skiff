import { describe, expect, test } from 'bun:test';
import { allPermissions, statements } from './catalog.ts';
import {
	defaultAgentScopes,
	destructivePermissions,
	permissionCatalog,
	permissionsWithRisk,
	roles,
	stepUpPermissions,
} from '../permissions.ts';

describe('permission catalog', () => {
	test('every permission has one metadata entry and a description', () => {
		expect(Object.keys(permissionCatalog).sort()).toEqual([...allPermissions].sort());
		for (const permission of allPermissions) {
			const meta = permissionCatalog[permission];
			expect(meta.permission).toBe(permission);
			expect(String(meta.resource)).toBe(permission.split(':')[0]!);
			expect(meta.action).toBe(permission.split(':')[1]!);
			expect(meta.description.length).toBeGreaterThan(0);
		}
	});

	test('every permission can be granted somewhere', () => {
		for (const permission of allPermissions) {
			const { scopes } = permissionCatalog[permission];
			expect(scopes.length).toBeGreaterThan(0);
			expect(scopes.includes('org') || scopes.includes('platform')).toBe(true);
			expect(new Set(scopes).size).toBe(scopes.length);
		}
	});

	test('secret and admin permissions are never offered to MCP clients', () => {
		for (const permission of allPermissions) {
			const meta = permissionCatalog[permission];
			if (meta.risk === 'secret' || meta.risk === 'admin') expect(meta.mcp).toBe(false);
			if (meta.risk === 'admin') expect(meta.tokens).toBe('deny');
		}
	});

	test('destructive permissions come from the catalog, not a second list', () => {
		expect(destructivePermissions).toEqual(permissionsWithRisk(permissionCatalog, 'destructive'));
		expect(destructivePermissions).toContain('project:delete');
		expect(destructivePermissions).toContain('member:remove');
	});

	test('risky permissions need step-up; reads and writes do not', () => {
		for (const permission of allPermissions) {
			const meta = permissionCatalog[permission];
			if (meta.risk === 'secret' || meta.risk === 'destructive' || meta.risk === 'admin')
				expect(meta.stepUp).not.toBe('none');
			if (meta.risk === 'read' || meta.risk === 'write') expect(meta.stepUp).toBe('none');
		}
		expect(permissionCatalog['org:transfer'].stepUp).toBe('always');
		expect(stepUpPermissions).toContain('org:transfer');
	});

	test('only deployer permissions an agent may hold are pre-ticked', () => {
		const deployer = new Set<string>(roles.deployer);
		for (const permission of allPermissions) {
			if (permissionCatalog[permission].agentDefault)
				expect(deployer.has(permission)).toBe(true);
		}
		expect(defaultAgentScopes.length).toBeGreaterThan(0);
		expect(permissionCatalog['database:credentials'].agentDefault).toBe(false);
		expect(permissionCatalog['pipeline:dispatch'].agentDefault).toBe(false);
	});

	test('apiKey is a deprecated alias of accessKey for the actions it still has', () => {
		for (const permission of allPermissions.filter((p) => p.startsWith('apiKey:'))) {
			expect(permissionCatalog[permission].deprecated).toBe(true);
			const alias = permission.replace('apiKey:', 'accessKey:') as (typeof allPermissions)[number];
			expect(allPermissions).toContain(alias);
			expect(permissionCatalog[alias].risk).toBe(permissionCatalog[permission].risk);
		}
	});

	test('the owner/admin split is in the role table', () => {
		const ownersOnly = [
			'org:delete',
			'org:transfer',
			'iam:manage-owners',
			'iam:manage-guardrails',
		] as const;
		for (const permission of ownersOnly) {
			expect(roles.owner).toContain(permission);
			expect(roles.admin).not.toContain(permission);
		}
	});

	test('an org rename stays an interactive-session action', () => {
		expect(permissionCatalog['org:update'].tokens).toBe('session-only');
		expect(permissionCatalog['org:update'].risk).toBe('write');
	});

	test('every statement resource has at least one action', () => {
		for (const actions of Object.values(statements)) expect(actions.length).toBeGreaterThan(0);
	});
});

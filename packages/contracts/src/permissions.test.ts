import { describe, expect, test } from 'bun:test';
import {
	allPermissions,
	defaultAgentScopes,
	destructivePermissions,
	effectivePermissions,
	roles,
} from './permissions.ts';

describe('permissions', () => {
	test('every role only contains known permissions', () => {
		for (const perms of Object.values(roles))
			for (const p of perms) expect(allPermissions).toContain(p);
	});

	test('default agent scopes never include destructive permissions', () => {
		for (const p of destructivePermissions) expect(defaultAgentScopes).not.toContain(p);
	});

	test('effective permissions = granted ∩ role, ignoring unknown scopes', () => {
		const eff = effectivePermissions(
			['openid', 'project:read', 'project:delete', 'bogus:thing'],
			'deployer',
		);
		expect([...eff]).toEqual(['project:read']);
	});

	test('a viewer cannot be elevated by a broad token', () => {
		const eff = effectivePermissions(allPermissions, 'viewer');
		expect(eff.has('deployment:create')).toBe(false);
		expect(eff.has('deployment:read')).toBe(true);
	});
});

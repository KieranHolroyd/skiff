import { describe, expect, test } from 'bun:test';
import { allPermissions, isPermission } from './catalog.ts';
import { systemPermissions, systemPrincipals } from './system.ts';

describe('system principals', () => {
	test('every spec has a non-empty permission list from the catalog', () => {
		for (const name of Object.keys(systemPrincipals) as Array<keyof typeof systemPrincipals>) {
			const spec = systemPrincipals[name];
			expect(spec.name).toBe(name);
			expect(spec.description.length).toBeGreaterThan(0);
			expect(spec.permissions.length).toBeGreaterThan(0);
			for (const permission of spec.permissions) {
				expect(isPermission(permission)).toBe(true);
				expect(allPermissions).toContain(permission);
			}
			expect(systemPermissions(name)).toBe(spec.permissions);
		}
	});

	test('no spec gets every permission', () => {
		for (const spec of Object.values(systemPrincipals)) {
			expect(spec.permissions.length).toBeLessThan(allPermissions.length);
		}
	});

	test('names are unique', () => {
		const names = Object.values(systemPrincipals).map((spec) => spec.name);
		expect(new Set(names).size).toBe(names.length);
	});
});

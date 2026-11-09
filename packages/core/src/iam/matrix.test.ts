import { describe, expect, test } from 'bun:test';
import {
	allPermissions,
	authorize,
	compileGrants,
	permissionCatalog,
	type Binding,
	type Permission,
	type ResourceRef,
} from '@yoal/contracts';

/**
 * The permission matrix (IAM.md I1's exit criterion): every catalog permission is checked against
 * the binding shapes the engine promises to honour. A new permission fails here until the engine
 * and the catalog agree on it.
 */
const now = Date.UTC(2026, 10, 8, 12, 0, 0);
const org: ResourceRef = { type: 'org' };
const project: ResourceRef = { type: 'project', id: 'prj_1' };
const otherProject: ResourceRef = { type: 'project', id: 'prj_2' };

function binding(permission: Permission, overrides: Partial<Binding> = {}): Binding {
	return {
		id: 'bind_1',
		roleId: 'custom',
		permissions: [permission],
		scope: { type: 'org' },
		...overrides,
	};
}

function decide(
	permission: Permission,
	resource: ResourceRef,
	input: {
		bindings?: Binding[];
		guardrails?: Parameters<typeof compileGrants>[0]['guardrails'];
		restriction?: Parameters<typeof compileGrants>[0]['restriction'];
		context?: Partial<NonNullable<Parameters<typeof authorize>[1]['context']>>;
	} = {},
) {
	return authorize(
		compileGrants({
			orgId: 'org_1',
			bindings: input.bindings ?? [],
			guardrails: input.guardrails,
			restriction: input.restriction,
		}),
		{
			permission,
			resource,
			context: { now, credential: 'session', ...input.context },
		},
	);
}

describe('permission matrix', () => {
	test('every permission has a reachable org grant', () => {
		for (const permission of allPermissions)
			expect(decide(permission, org, { bindings: [binding(permission)] })).toMatchObject({
				allow: true,
				reason: 'binding',
			});
	});

	test('a project binding grants the project and nothing else', () => {
		for (const permission of allPermissions) {
			const scoped = binding(permission, { scope: { type: 'project', id: 'prj_1' } });
			expect(decide(permission, project, { bindings: [scoped] }).allow).toBe(true);
			expect(decide(permission, otherProject, { bindings: [scoped] }).allow).toBe(false);
			expect(decide(permission, org, { bindings: [scoped] }).allow).toBe(false);
		}
	});

	test('an expired binding never allows', () => {
		for (const permission of allPermissions) {
			const expired = binding(permission, { expiresAt: now });
			expect(decide(permission, org, { bindings: [expired] })).toMatchObject({
				allow: false,
				reason: 'expired',
			});
		}
	});

	test('a guardrail template can deny every permission', () => {
		for (const permission of allPermissions) {
			const decision = decide(permission, org, {
				bindings: [binding(permission)],
				guardrails: [{ id: 'g', permissions: [permission] }],
			});
			expect(decision).toMatchObject({ allow: false, reason: 'guardrail' });
		}
	});

	test('a token whose grants exclude the permission is restricted', () => {
		for (const permission of allPermissions) {
			if (permission === 'project:read') continue;
			const decision = decide(permission, org, {
				bindings: [binding(permission)],
				restriction: { permissions: ['project:read'] },
			});
			expect(decision).toMatchObject({ allow: false, reason: 'restricted' });
		}
	});

	test('a session-only condition refuses an API key', () => {
		for (const permission of allPermissions) {
			const decision = decide(permission, org, {
				bindings: [binding(permission, { condition: { op: 'credentialIn', credentials: ['session'] } })],
				context: { credential: 'apiKey' },
			});
			expect(decision).toMatchObject({ allow: false, reason: 'condition' });
		}
	});

	test('every permission is classified for tokens and MCP', () => {
		const confirmedMcpWrites: readonly Permission[] = ['serviceAccount:create', 'iam:manage-bindings'];
		for (const permission of allPermissions) {
			const meta = permissionCatalog[permission];
			// Confirmed MCP writes are the one deliberate exception: the human click is the gate.
			if (meta.tokens === 'deny' && !confirmedMcpWrites.includes(permission))
				expect(meta.mcp).toBe(false);
			expect(['none', 'window', 'always']).toContain(meta.stepUp);
		}
	});
});

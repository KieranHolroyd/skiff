import type { Permission, Principal, Role } from '@yoal/contracts';
import { isPermission, roles as roleDefinitions } from '@yoal/contracts';

/**
 * A complete stand-in for `./principal` in tests that `mock.module` it. Bun's module mocks are
 * process-wide, so a partial mock (only `principalFromMcp`) breaks every later test file that
 * imports another export such as `requirePrincipal`. Override just what a test needs:
 * `mock.module('./principal', () => principalStub({ principalFromMcp: () => null }))`.
 */
export function principalStub(overrides: Record<string, unknown> = {}) {
	return {
		principalFromSession: () => undefined,
		principalFromRequest: async () => undefined,
		principalFromMcp: () => undefined,
		requirePrincipal(event: { locals: { principal?: Principal } }): Principal {
			const principal = event.locals.principal;
			if (!principal) throw new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
			return principal;
		},
		isPermissionList: (values: unknown): values is Permission[] =>
			Array.isArray(values) && values.every((value) => typeof value === 'string' && isPermission(value)),
		rolePermissions: (role: Role): readonly Permission[] => roleDefinitions[role],
		...overrides
	};
}

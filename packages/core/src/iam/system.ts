/**
 * Builds a named system principal (IAM.md §7.1, I3).
 *
 * Deliberately not routed through `buildPrincipal`: that function intersects the grant with the
 * built-in role, and a system principal's permissions are fixed by its spec, not by a role. The
 * `viewer` role is only a placeholder for the legacy `role` field; nothing reads it for a system
 * principal.
 */
import type { ActingFor, CredentialKind, Principal, systemPrincipals } from '@skiff/contracts';
import { systemPermissions } from '@skiff/contracts';

export function buildSystemPrincipal(
	name: keyof typeof systemPrincipals,
	orgId: string,
	options: { actingFor?: ActingFor; credential?: CredentialKind } = {},
): Principal {
	return {
		kind: 'system',
		userId: name,
		orgId,
		role: 'viewer',
		permissions: new Set(systemPermissions(name)),
		credential: options.credential ?? 'system',
		actingFor: options.actingFor,
		platformAdmin: false,
	};
}

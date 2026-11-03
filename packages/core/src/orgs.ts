import type { Database } from 'bun:sqlite';
import type { Permission, Principal, Role } from '@skiff/contracts';
import { roles as roleDefinitions } from '@skiff/contracts';
import { ForbiddenError } from './errors.ts';
import { newId } from './util.ts';

/**
 * Org membership lives in Better Auth's `organization`/`member` tables (D9). The control plane
 * resolves a session into a Principal here; the MCP and API paths use the same function so no
 * surface can out-perform another.
 */
export interface Membership {
	orgId: string;
	role: Role;
}

export function isRole(value: string): value is Role {
	return value in roleDefinitions;
}

export function readMembership(sqlite: Database, userId: string): Membership | undefined {
	try {
		const row = sqlite
			.query<{ organizationId: string; role: string }, [string]>(
				'SELECT organizationId, role FROM member WHERE userId = ? ORDER BY createdAt ASC LIMIT 1',
			)
			.get(userId);
		if (!row) return undefined;
		return { orgId: row.organizationId, role: isRole(row.role) ? row.role : 'viewer' };
	} catch {
		// Auth tables not present (unit tests / bootstrapping before migrations).
		return undefined;
	}
}

/** Create the user's personal org on first use; the first user is the owner. */
export function ensurePersonalOrg(sqlite: Database, userId: string, name = 'Personal'): Membership {
	const now = new Date();
	const orgId = newId('org_');
	const slug = `org-${orgId.slice(4, 16)}`;
	sqlite.transaction(() => {
		sqlite.run('INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)', [
			orgId,
			name,
			slug,
			now.toISOString(),
		]);
		sqlite.run(
			'INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)',
			[newId('mem_'), orgId, userId, 'owner', now.toISOString()],
		);
	})();
	return { orgId, role: 'owner' };
}

export function resolveMembership(sqlite: Database, userId: string, fallbackName?: string): Membership {
	return readMembership(sqlite, userId) ?? ensurePersonalOrg(sqlite, userId, fallbackName);
}

export function assertRoleCan(role: Role, permission: Permission): void {
	const allowed = new Set<string>(roleDefinitions[role]);
	if (!allowed.has(permission)) throw new ForbiddenError(permission);
}

/**
 * A token's effective permissions are always `granted scopes ∩ the user's current role`
 * (packages/contracts): revoking a role immediately narrows every token.
 */
export function buildPrincipal(input: {
	userId: string;
	orgId: string;
	role: Role;
	kind: Principal['kind'];
	granted?: Iterable<string>;
	clientId?: string;
	keyId?: string;
	ipHash?: string;
}): Principal {
	const rolePermissions = new Set<string>(roleDefinitions[input.role]);
	const granted = input.granted ? new Set(input.granted) : rolePermissions;
	const permissions = new Set(
		[...granted].filter((permission) => rolePermissions.has(permission)),
	) as Set<Permission>;
	return {
		kind: input.kind,
		userId: input.userId,
		orgId: input.orgId,
		role: input.role,
		permissions,
		clientId: input.clientId,
		keyId: input.keyId,
		ipHash: input.ipHash,
	};
}

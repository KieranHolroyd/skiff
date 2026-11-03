import type { Permission, Role } from './permissions.ts';

/** The identity every surface (dashboard, REST, MCP, CLI, agent) reduces to before a service call. */
export interface Principal {
	kind: 'user' | 'apiKey' | 'mcp' | 'system';
	userId: string;
	orgId: string;
	role: Role;
	/** Effective permissions: granted scopes ∩ the role. */
	permissions: ReadonlySet<Permission>;
	/** MCP client id / API key id, for the audit log. */
	clientId?: string;
	keyId?: string;
	ipHash?: string;
	/**
	 * Platform admin (Better Auth admin-plugin `user.role` includes `admin`), DESIGN §6.2. Orthogonal
	 * to the org role: being an org owner never makes you a platform admin. Fleet mutations also
	 * require an interactive session (see `canAdministerPlatform`).
	 */
	platformAdmin?: boolean;
}

/** Read-only platform views (e.g. `list_nodes`): any surface of a platform-admin user. */
export function canViewPlatform(principal: Principal): boolean {
	return principal.platformAdmin === true || principal.kind === 'system';
}

/**
 * Platform mutations (join tokens, drain, token rotation): a platform admin's own dashboard session
 * only. API keys and OAuth tokens never carry platform scope, so a narrowly-scoped key can't mint
 * node credentials. `system` principals are internal (installer) and never reachable from a surface.
 */
export function canAdministerPlatform(principal: Principal): boolean {
	return (principal.platformAdmin === true && principal.kind === 'user') || principal.kind === 'system';
}

export function hasPermission(principal: Principal, permission: Permission): boolean {
	return principal.permissions.has(permission);
}

export class ForbiddenError extends Error {
	readonly permission: Permission;
	constructor(permission: Permission) {
		super(`Missing permission ${permission}`);
		this.name = 'ForbiddenError';
		this.permission = permission;
	}
}

export function requirePermission(principal: Principal, permission: Permission): void {
	if (!hasPermission(principal, permission)) throw new ForbiddenError(permission);
}

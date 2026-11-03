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

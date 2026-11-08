import type { Permission, Role } from './permissions.ts';

/**
 * Who is acting (IAM.md §7.1). `user` covers a person on any surface (session, key, MCP token,
 * CLI); the rest are machines or named internal actors. The older four values stay valid, so the
 * check-site migration (I2) can land in steps.
 */
export type PrincipalKind =
	| 'user'
	| 'apiKey'
	| 'mcp'
	| 'system'
	| 'serviceAccount'
	| 'workload'
	| 'job'
	| 'node';

/** How the principal proved itself (IAM.md §2), recorded on decisions and audit rows. */
export type CredentialKind =
	| 'session'
	| 'apiKey'
	| 'oauth'
	| 'sts'
	| 'workload'
	| 'job'
	| 'node'
	| 'system';

/** A machine acting on someone's behalf: a job for the person who started a run, a token for a user. */
export interface ActingFor {
	kind: PrincipalKind;
	id: string;
}

/** The identity every surface (dashboard, REST, MCP, CLI, agent) reduces to before a service call. */
export interface Principal {
	kind: PrincipalKind;
	/**
	 * The stable principal id. For a person this is the user id; service accounts use `sa_…`,
	 * workloads `wl:…`, jobs and nodes their own row id. Kept under the old name so every existing
	 * caller and audit query keeps working (IAM.md I2).
	 */
	userId: string;
	orgId: string;
	/** The built-in role this principal resolves to today. I1 replaces reads of this with bindings. */
	role: Role;
	/** Effective permissions: granted scopes ∩ the role. */
	permissions: ReadonlySet<Permission>;
	/** The person or principal a machine or impersonation token is acting for. */
	actingFor?: ActingFor;
	/** Which kind of credential proved the principal, for audit and conditions. */
	credential?: CredentialKind;
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

/** A person at a keyboard, on any surface. Machines and named system actors are not human. */
export function isHumanPrincipal(principal: Principal): boolean {
	return principal.kind === 'user' || principal.kind === 'apiKey' || principal.kind === 'mcp';
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

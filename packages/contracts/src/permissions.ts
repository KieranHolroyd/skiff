/**
 * The single source of truth for Skiff's org-level permissions (DESIGN §6.2).
 *
 * The same `resource:action` strings are used as:
 *  - Better Auth organization access-control statements (RBAC roles),
 *  - OAuth scopes requested by MCP clients and shown on the consent screen,
 *  - API-key permission sets.
 *
 * A token's effective permissions are always `granted scopes ∩ the user's current role`,
 * so revoking a role immediately narrows every token the user has issued.
 */
export const statements = {
	project: ['create', 'read', 'update', 'delete'],
	deployment: ['create', 'read', 'promote', 'rollback', 'delete'],
	domain: ['create', 'read', 'delete'],
	secret: ['create', 'read-metadata', 'update', 'delete'],
	build: ['create', 'read', 'cancel'],
	database: ['create', 'read', 'update', 'delete', 'credentials', 'console'],
	storage: ['create', 'read', 'update', 'delete', 'credentials'],
	broker: ['create', 'read', 'update', 'delete', 'credentials'],
	// Email (docs/EMAIL.md): domains, sending, suppressions, routes, credentials.
	email: ['read', 'send', 'update', 'delete', 'credentials'],
	shareLink: ['create', 'read', 'revoke'],
	logs: ['read'],
	// Container console (D127): inspect a project's container, browse its files, open a shell.
	container: ['inspect', 'files', 'exec'],
	metrics: ['read'],
	apiKey: ['create', 'read', 'revoke'],
	member: ['invite', 'update-role', 'remove'],
} as const;

export type Resource = keyof typeof statements;
export type Permission = {
	[R in Resource]: `${R}:${(typeof statements)[R][number]}`;
}[Resource];

export const allPermissions = Object.entries(statements).flatMap(([resource, actions]) =>
	actions.map((action) => `${resource}:${action}` as Permission),
);

export const isPermission = (value: string): value is Permission =>
	(allPermissions as readonly string[]).includes(value);

const pick = (...perms: Permission[]) => perms;

export const roles = {
	owner: allPermissions,
	admin: allPermissions,
	deployer: pick(
		'project:create', 'project:read', 'project:update',
		'deployment:create', 'deployment:read', 'deployment:promote', 'deployment:rollback',
		'domain:read', 'secret:create', 'secret:read-metadata', 'secret:update',
		'build:create', 'build:read', 'build:cancel',
		'database:create', 'database:read', 'database:update', 'database:credentials', 'database:console',
		'storage:create', 'storage:read', 'storage:update', 'storage:credentials',
		'broker:create', 'broker:read', 'broker:update', 'broker:credentials',
		'email:read', 'email:send', 'email:update', 'email:credentials',
		'shareLink:create', 'shareLink:read', 'shareLink:revoke',
		'logs:read', 'metrics:read',
		'container:inspect', 'container:files', 'container:exec',
	),
	viewer: pick(
		'project:read', 'deployment:read', 'domain:read', 'secret:read-metadata',
		'build:read', 'database:read', 'storage:read', 'broker:read', 'email:read', 'shareLink:read', 'logs:read', 'metrics:read',
		'container:inspect',
	),
} as const satisfies Record<string, readonly Permission[]>;

export type Role = keyof typeof roles;

/**
 * Default scopes pre-ticked on the OAuth consent screen for an agent (DESIGN §6.3):
 * deployer-level, with destructive permissions left unticked.
 */
export const defaultAgentScopes: readonly Permission[] = roles.deployer.filter(
	// Agents get connection URLs injected into apps; revealing passwords is a human opt-in (D58).
	// The studio is an interactive human surface (D60); agents never get it as a default scope.
	(permission) =>
		permission !== 'database:credentials' &&
		permission !== 'storage:credentials' &&
		permission !== 'broker:credentials' &&
		permission !== 'email:credentials' &&
		permission !== 'database:console' &&
		// A shell and file reads inside a container are a human surface too (D127).
		permission !== 'container:files' &&
		permission !== 'container:exec',
);

/** Permissions that are never pre-ticked and always require an explicit opt-in. */
export const destructivePermissions: readonly Permission[] = [
	'project:delete',
	'deployment:delete',
	'domain:delete',
	'database:delete',
	'storage:delete',
	'broker:delete',
	'email:delete',
	'secret:delete',
	'apiKey:revoke',
	'member:remove',
];

/** Effective permissions for a request: what the token was granted, capped by the user's role. */
export function effectivePermissions(
	granted: Iterable<string>,
	role: Role,
): Set<Permission> {
	const allowed = new Set<string>(roles[role]);
	const out = new Set<Permission>();
	for (const scope of granted) if (isPermission(scope) && allowed.has(scope)) out.add(scope);
	return out;
}

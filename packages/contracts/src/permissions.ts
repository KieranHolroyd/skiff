/**
 * Skiff's org-level permissions (DESIGN §6.2, IAM.md).
 *
 * The catalog in `iam/catalog.ts` is the source of truth for the permission strings and their
 * metadata. This file keeps the parts every existing surface already imports: the built-in roles,
 * the agent consent defaults, the destructive list and the `granted ∩ role` helper.
 */
import {
	allPermissions,
	buildPermissionCatalog,
	isPermission,
	permissionsWithRisk,
	type Permission,
} from './iam/catalog.ts';

export { allPermissions, isPermission, statements } from './iam/catalog.ts';
export { buildPermissionCatalog, permissionsWithRisk } from './iam/catalog.ts';
export type { Permission, Resource } from './iam/catalog.ts';
export type { PermissionMeta, Risk, ScopeType, StepUp, TokenRule } from './iam/catalog.ts';

const pick = (...perms: Permission[]) => perms;

export const roles = {
	owner: allPermissions,
	// The owner/admin split agreed in IAM.md §15: these four are owner-only. Everything else is
	// shared, because admin is the everyday org administrator.
	admin: allPermissions.filter(
		(permission) =>
			permission !== 'org:delete' &&
			permission !== 'org:transfer' &&
			permission !== 'iam:manage-owners' &&
			permission !== 'iam:manage-guardrails',
	),
	deployer: pick(
		'project:create', 'project:read', 'project:update',
		'environment:read',
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
		'image:pull', 'image:push', 'image:credentials',
		'pipeline:read', 'pipeline:dispatch', 'pipeline:cancel',
		'alert:read', 'alert:acknowledge',
		'dashboard:read', 'volume:read',
	),
	viewer: pick(
		'project:read', 'deployment:read', 'domain:read', 'secret:read-metadata',
		'build:read', 'database:read', 'storage:read', 'broker:read', 'email:read', 'shareLink:read', 'logs:read', 'metrics:read',
		'container:inspect', 'image:pull',
		'environment:read', 'pipeline:read', 'alert:read', 'dashboard:read', 'volume:read',
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
		// Registry passwords and tokens are a human opt-in, like the other credentials (D58).
		permission !== 'image:credentials' &&
		permission !== 'database:console' &&
		// A shell and file reads inside a container are a human surface too (D127).
		permission !== 'container:files' &&
		permission !== 'container:exec' &&
		// Starting a pipeline runs repository code with secrets: an explicit opt-in, like a shell.
		permission !== 'pipeline:dispatch',
);

/**
 * The catalog, with every permission's scopes, risk, step-up level, token rule and MCP visibility.
 * Built here because `agentDefault` depends on the deployer-role defaults above.
 */
export const permissionCatalog = buildPermissionCatalog(new Set(defaultAgentScopes));

/** Permissions that are never pre-ticked and always require an explicit opt-in. */
export const destructivePermissions: readonly Permission[] = permissionsWithRisk(
	permissionCatalog,
	'destructive',
);

/** Permissions that need a fresh verification before they may be used (STEP-UP.md §4). */
export const stepUpPermissions: readonly Permission[] = allPermissions.filter(
	(permission) => permissionCatalog[permission].stepUp !== 'none',
);

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

/**
 * The permission catalog (IAM.md I1, DESIGN §6.2).
 *
 * This is the single source of truth for Skiff's permissions. Everything that used to restate the
 * same facts is derived from here:
 *  - `statements`, for Better Auth's organization access control and the OAuth consent screen;
 *  - the built-in roles in `permissions.ts`;
 *  - `destructivePermissions` (risk `destructive`);
 *  - `STEP_UP_ACTIONS` (IAM.md §9.1), once STEP-UP.md ships.
 *
 * Each permission records where it may be granted (`scopes`), how dangerous it is (`risk`), whether
 * it needs step-up, which credentials may carry it (`tokens`, STEP-UP.md §7), whether MCP clients
 * may hold it (D58) and whether an agent consent screen pre-ticks it.
 *
 * Adding an action means adding it to `statements` and, if the defaults below don't fit, to one of
 * the override tables. `buildPermissionCatalog` throws for an action it can't classify, so a new
 * permission can never ship without metadata.
 */

/** Where a binding may apply. Scopes nest `platform` › `org` › `project` › `environment` › resource. */
export type ScopeType =
	| 'platform'
	| 'org'
	| 'project'
	| 'environment'
	| 'deployment'
	| 'secret'
	| 'build'
	| 'database'
	| 'storage'
	| 'broker'
	| 'emailDomain'
	| 'shareLink'
	| 'container'
	| 'repository'
	| 'pipelineRepository'
	| 'userPool'
	| 'accessPolicy'
	| 'apiKey';

/** How much damage a permission can do. Drives step-up defaults and the role editor's warnings. */
export type Risk = 'read' | 'write' | 'destructive' | 'secret' | 'admin';

/** STEP-UP.md §4. `window` is satisfied by a verification within the session window. */
export type StepUp = 'none' | 'window' | 'always';

/** STEP-UP.md §7: may an API key, CLI token or MCP token carry this permission? */
export type TokenRule = 'allow' | 'deny' | 'session-only';

export interface PermissionMeta {
	readonly permission: Permission;
	readonly resource: Resource;
	readonly action: string;
	/** Where a binding for this permission may be attached, narrowest last. */
	readonly scopes: readonly ScopeType[];
	readonly risk: Risk;
	readonly stepUp: StepUp;
	readonly tokens: TokenRule;
	/** May an MCP client hold this permission (D58)? */
	readonly mcp: boolean;
	/** Pre-ticked on an agent consent screen. */
	readonly agentDefault: boolean;
	/** Shown in the role editor and on the consent screen. */
	readonly description: string;
	/** Kept for one release while `accessKey:*` replaces `apiKey:*` (IAM.md §3). */
	readonly deprecated?: boolean;
}

/**
 * The `resource:action` table. Same strings as before, plus the resources IAM.md §3 adds: platform
 * and IAM administration, service accounts, access keys, federation, SSO, audit, environments,
 * pipelines, alerts, log drains, dashboards, volumes and Part B's user pools and access policies.
 *
 * `member` keeps its Better Auth actions in `apps/control-plane/src/lib/server/auth.ts`; this table
 * is the Skiff subset the API, MCP and CLI use.
 */
export const statements = {
	org: ['read', 'update', 'delete', 'transfer'],
	iam: ['read', 'manage-roles', 'manage-bindings', 'manage-groups', 'manage-owners', 'manage-guardrails', 'review'],
	serviceAccount: ['create', 'read', 'update', 'delete', 'impersonate', 'manage-keys'],
	accessKey: ['create', 'read', 'revoke', 'read-all', 'revoke-any'],
	// Deprecated alias of `accessKey` (IAM.md §3). Removed one release after I3.
	apiKey: ['create', 'read', 'revoke'],
	federation: ['create', 'read', 'update', 'delete'],
	sso: ['read', 'manage'],
	audit: ['read', 'export'],
	member: ['invite', 'update-role', 'remove'],
	environment: ['create', 'read', 'update', 'delete', 'approve'],
	pipeline: ['read', 'dispatch', 'cancel', 'manage', 'approve'],
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
	// Container images (docs/REGISTRY.md): pull and push the org's registry repositories, delete
	// tags, and manage credentials for external registries (R2).
	image: ['pull', 'push', 'delete', 'credentials'],
	metrics: ['read'],
	alert: ['create', 'read', 'update', 'delete', 'acknowledge'],
	logDrain: ['create', 'read', 'update', 'delete'],
	dashboard: ['create', 'read', 'update', 'delete'],
	volume: ['create', 'read', 'update', 'delete'],
	// Part B: identity for tenant apps (IAM.md §11).
	userPool: ['create', 'read', 'update', 'delete', 'credentials', 'manage-users', 'impersonate-user'],
	accessPolicy: ['create', 'read', 'update', 'delete'],
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

/** Where each resource's bindings may attach. Every permission also reads at org scope. */
const RESOURCE_SCOPES: Record<Resource, readonly ScopeType[]> = {
	org: ['platform', 'org'],
	iam: ['platform', 'org'],
	serviceAccount: ['platform', 'org'],
	accessKey: ['org'],
	apiKey: ['org'],
	federation: ['platform', 'org'],
	sso: ['platform', 'org'],
	audit: ['platform', 'org'],
	member: ['org', 'project'],
	environment: ['org', 'project', 'environment'],
	pipeline: ['org', 'project', 'pipelineRepository'],
	project: ['org', 'project'],
	deployment: ['org', 'project', 'environment', 'deployment'],
	domain: ['org', 'project'],
	secret: ['org', 'project', 'environment'],
	build: ['org', 'project'],
	database: ['org', 'project', 'database'],
	storage: ['org', 'project', 'storage'],
	broker: ['org', 'project', 'broker'],
	email: ['org', 'emailDomain'],
	shareLink: ['org', 'project'],
	logs: ['org', 'project', 'environment'],
	container: ['org', 'project', 'environment', 'container'],
	image: ['org', 'project', 'repository'],
	metrics: ['org', 'project', 'environment'],
	alert: ['org', 'project'],
	logDrain: ['org', 'project'],
	dashboard: ['org', 'project'],
	volume: ['org', 'project'],
	userPool: ['org', 'userPool'],
	accessPolicy: ['org', 'project', 'environment', 'accessPolicy'],
};

/** Actions whose risk follows from their name. Anything else needs an override. */
const RISK_BY_ACTION: Record<string, Risk> = {
	read: 'read',
	'read-metadata': 'read',
	'read-all': 'read',
	inspect: 'read',
	export: 'read',
	pull: 'read',
	create: 'write',
	update: 'write',
	send: 'write',
	promote: 'write',
	rollback: 'write',
	push: 'write',
	cancel: 'write',
	dispatch: 'write',
	approve: 'write',
	acknowledge: 'write',
	invite: 'write',
	'update-role': 'write',
	'manage-users': 'write',
	review: 'write',
	delete: 'destructive',
	revoke: 'destructive',
	'revoke-any': 'destructive',
	remove: 'destructive',
	credentials: 'secret',
	console: 'secret',
	exec: 'secret',
	files: 'secret',
	impersonate: 'secret',
	'impersonate-user': 'secret',
	'manage-keys': 'secret',
	transfer: 'admin',
	'manage-roles': 'admin',
	'manage-bindings': 'admin',
	'manage-groups': 'admin',
	'manage-owners': 'admin',
	'manage-guardrails': 'admin',
	manage: 'admin',
};

/** Per-permission corrections where the action name alone would mis-classify. */
const RISK_OVERRIDE: Partial<Record<Permission, Risk>> = {
	'org:delete': 'admin',
	'pipeline:manage': 'write',
	'iam:review': 'write',
	// Revoking a share link is a write, not destruction: the link can be reissued and deployers
	// have held this permission since D21.
	'shareLink:revoke': 'write',
};

/** Step-up level, when the risk default isn't right. Ownership changes are `always` (STEP-UP §4). */
const STEP_UP_OVERRIDE: Partial<Record<Permission, StepUp>> = {
	'org:delete': 'always',
	'org:transfer': 'always',
	'iam:manage-owners': 'always',
};

/** Credentials that may never carry the permission (STEP-UP.md §7), beyond `risk: admin`. */
const TOKEN_DENY: readonly Permission[] = [
	'member:invite',
	'member:update-role',
	'member:remove',
	'apiKey:create',
	'apiKey:revoke',
	'accessKey:create',
	'accessKey:revoke-any',
	'serviceAccount:create',
	'serviceAccount:update',
	'serviceAccount:delete',
	'serviceAccount:impersonate',
	'serviceAccount:manage-keys',
	'sso:manage',
	'federation:create',
	'federation:update',
	'federation:delete',
	'container:exec',
	'container:files',
	'database:console',
	'userPool:credentials',
	'userPool:impersonate-user',
	'userPool:manage-users',
];

/** Permissions an interactive session may use but a token may not (STEP-UP.md §7). */
const TOKEN_SESSION_ONLY: readonly Permission[] = [
	// Renaming an org keeps the old "own dashboard session only" rule it has today.
	'org:update',
];

/** Never offered to an MCP client, even when a token could hold it. */
const MCP_DENY: readonly Permission[] = [
	'accessKey:create',
	'accessKey:revoke',
	'accessKey:revoke-any',
	'serviceAccount:create',
	'serviceAccount:update',
	'serviceAccount:delete',
	'serviceAccount:impersonate',
	'serviceAccount:manage-keys',
	'sso:manage',
	'federation:create',
	'federation:update',
	'federation:delete',
	'member:invite',
	'member:update-role',
	'member:remove',
	'audit:export',
	'org:delete',
	'org:transfer',
];

/** The Risky actions each permission inherits when nothing more specific is set. */
function riskFor(permission: Permission): Risk {
	const override = RISK_OVERRIDE[permission];
	if (override) return override;
	const action = permission.slice(permission.indexOf(':') + 1);
	const risk = RISK_BY_ACTION[action];
	if (!risk)
		throw new Error(
			`Permission ${permission} has no risk class. Add it to RISK_BY_ACTION or RISK_OVERRIDE.`,
		);
	return risk;
}

function defaultStepUp(risk: Risk): StepUp {
	return risk === 'secret' || risk === 'destructive' || risk === 'admin' ? 'window' : 'none';
}

/** Kept as a list so `apiKey:*` and its `accessKey:*` replacement stay in step. */
const DEPRECATED_PERMISSIONS: readonly Permission[] = [
	'apiKey:create',
	'apiKey:read',
	'apiKey:revoke',
];

/**
 * Build the catalog. `agentDefaults` comes from the deployer role minus the opt-ins in
 * `permissions.ts`, which keeps the consent screen's pre-ticked set exactly as it is today.
 */
export function buildPermissionCatalog(
	agentDefaults: ReadonlySet<Permission>,
): Record<Permission, PermissionMeta> {
	const catalog = {} as Record<Permission, PermissionMeta>;
	for (const [resource, actions] of Object.entries(statements)) {
		for (const action of actions) {
			const permission = `${resource}:${action}` as Permission;
			const risk = riskFor(permission);
			catalog[permission] = {
				permission,
				resource: resource as Resource,
				action,
				scopes: RESOURCE_SCOPES[resource as Resource],
				risk,
				stepUp: STEP_UP_OVERRIDE[permission] ?? defaultStepUp(risk),
				tokens:
					risk === 'admin' || TOKEN_DENY.includes(permission)
						? 'deny'
						: TOKEN_SESSION_ONLY.includes(permission)
							? 'session-only'
							: 'allow',
				mcp: risk !== 'secret' && risk !== 'admin' && !MCP_DENY.includes(permission),
				agentDefault: agentDefaults.has(permission),
				description: `${resource} ${action.replace(/-/g, ' ')}`,
				...(DEPRECATED_PERMISSIONS.includes(permission) ? { deprecated: true as const } : {}),
			};
		}
	}
	return catalog;
}

/** Permissions of a given risk class, for role editors, guardrail templates and tests. */
export function permissionsWithRisk(
	catalog: Record<Permission, PermissionMeta>,
	risk: Risk,
): Permission[] {
	return allPermissions.filter((permission) => catalog[permission].risk === risk);
}

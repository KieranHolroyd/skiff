import { permissionCatalog, type Permission, type Role, type StepUp } from './permissions.ts';

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

/** How strong the factor used to prove it is really the person at the keyboard was. */
export type StepUpClass = 'strong' | 'basic';

/**
 * Step-up verification carried by a session-backed principal (STEP-UP.md §3, §6). `at` is when the
 * session last passed step-up, `class` is the factor it used, and `strongest` is the strongest
 * factor the person has enrolled *now*. A basic verification is not enough once a strong factor
 * exists, so adding a passkey can never put someone below the bar.
 */
export interface StepUpVerification {
	at: number;
	class: StepUpClass;
	strongest: StepUpClass;
}

/** The fixed window a `window`-level permission stays satisfied for (STEP-UP.md §3). */
export const STEP_UP_WINDOW_MS = 30 * 60 * 1000;

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
	/**
	 * The session's step-up state (STEP-UP.md §6). Filled in by `principalFromSession`; machine
	 * principals leave it undefined and depend on the catalog's token rule instead.
	 */
	verification?: StepUpVerification;
}

/** A person at a keyboard, on any surface. Machines and named system actors are not human. */
export function isHumanPrincipal(principal: Principal): boolean {
	return principal.kind === 'user' || principal.kind === 'apiKey' || principal.kind === 'mcp';
}

/**
 * A guest is a project-only member (IAM.md §8.2): their `member.role` is `guest` and every
 * permission comes from a project-scope binding. Org-level surfaces are empty or forbidden for
 * them. This is a display/surface shortcut; authorization still goes through the bindings engine.
 */
export function isGuestPrincipal(principal: Principal): boolean {
	return principal.role === 'guest';
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

/**
 * Platform-scope maintenance such as a fleet-wide prune: D129's session-only rule does not apply
 * here yet (docs/OPERATIONS.md §5.2 leaves API keys open), so a platform admin's API key may run it
 * while OAuth and MCP may not. `system` is the installer.
 */
export function canMaintainPlatform(principal: Principal): boolean {
	return canAdministerPlatform(principal) || (principal.platformAdmin === true && principal.kind === 'apiKey');
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

/** The catalog's step-up rule for a permission (STEP-UP.md §4, IAM.md §9.1). */
export function stepUpLevel(permission: Permission): StepUp {
	return permissionCatalog[permission].stepUp;
}

/** Thrown when a permission needs a fresher or stronger verification than the session has. */
export class StepUpRequiredError extends Error {
	readonly permission: Permission;
	/** `window` or `always`; never `none`, because `none` never throws. */
	readonly level: Exclude<StepUp, 'none'>;

	constructor(permission: Permission, level: Exclude<StepUp, 'none'>) {
		super(
			`Step-up verification required for ${permission}. Verify it's you in the dashboard, then try again.`,
		);
		this.name = 'StepUpRequiredError';
		this.permission = permission;
		this.level = level;
	}
}

const STEP_UP_RANK: Record<StepUpClass, number> = { basic: 1, strong: 2 };

/**
 * Require a fresh verification for a permission (STEP-UP.md §6). `always` actions ask every time;
 * `window` actions are satisfied by a verification no older than {@link STEP_UP_WINDOW_MS} whose
 * class is at least the strongest factor the person has enrolled. A permission with `stepUp:
 * 'none'` passes without any verification.
 *
 * Call this next to the permission check. It is deliberately not wired into any call site yet: the
 * surfaces are migrated in risk order in a later pass (STEP-UP.md §10).
 */
export function requireStepUp(
	principal: Principal,
	permission: Permission,
	now: number = Date.now(),
): void {
	const level = stepUpLevel(permission);
	if (level === 'none') return;
	if (level === 'always') throw new StepUpRequiredError(permission, level);

	const verification = principal.verification;
	if (!verification) throw new StepUpRequiredError(permission, level);
	// A fixed window, not sliding: verifying again restarts it (STEP-UP.md §3).
	if (now - verification.at >= STEP_UP_WINDOW_MS)
		throw new StepUpRequiredError(permission, level);
	if (STEP_UP_RANK[verification.class] < STEP_UP_RANK[verification.strongest])
		throw new StepUpRequiredError(permission, level);
}

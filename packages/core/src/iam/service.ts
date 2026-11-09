/**
 * IAM at org scope (IAM.md I1): loading, compiling and caching a principal's bindings, plus the
 * writes that keep them. The decision itself is pure and lives in `@skiff/contracts` (`authorize`).
 *
 * This is the seam every call site moves onto in I2:
 *
 *   iam.require(principal, permission, resource)   // throws ForbiddenError
 *   iam.can(principal, permission, resource)       // boolean
 *   iam.explain(principal, permission, resource)   // the decision and its chain
 *   iam.scopeFilter(principal, permission)         // 'all' | Set<id> for list queries
 *
 * `requirePermission(principal, permission)` keeps working until its call site moves over; it is
 * equivalent to `require(principal, permission, { type: 'org' })`.
 */
import type { Database } from 'bun:sqlite';
import {
	compileGrants,
	authorize,
	isPermission,
	requireStepUp,
	roles,
	stepUpLevel,
	type Binding,
	type CompiledGrants,
	type Condition,
	type Decision,
	type Guardrail,
	type Permission,
	type Principal,
	type ResourceRef,
	type Restriction,
	type Role,
	type ScopeRef,
} from '@skiff/contracts';
import type { CoreContext } from '../context.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { newId } from '../util.ts';
import { stepUpAppliesTo, stepUpEnabled } from './step-up.ts';

const ROLE_NAME = /^[a-z][a-z0-9-]{1,39}$/;
const PRINCIPAL_TYPES = ['user', 'group', 'serviceAccount'] as const;
type BindingPrincipalType = (typeof PRINCIPAL_TYPES)[number];

interface RoleRow {
	id: string;
	org_id: string | null;
	name: string;
	description: string;
	permissions_json: string;
	built_in: number;
	created_at: number;
}

interface BindingRow {
	id: string;
	org_id: string | null;
	principal_type: string;
	principal_id: string;
	role_id: string;
	scope_type: string;
	scope_id: string | null;
	scope_parent_id: string | null;
	condition_json: string | null;
	expires_at: number | null;
	reason: string | null;
	created_by: string;
	created_at: number;
}

interface GuardrailRow {
	id: string;
	org_id: string | null;
	name: string;
	principal_selector_json: string;
	permissions_json: string;
	scope_type: string | null;
	scope_id: string | null;
	scope_parent_id: string | null;
	condition_json: string | null;
}

interface GroupRow {
	id: string;
	org_id: string;
	name: string;
	description: string;
	source: string;
	external_id: string | null;
}

export interface RoleView {
	id: string;
	name: string;
	description: string;
	permissions: readonly Permission[];
	builtIn: boolean;
}

export interface BindingView {
	id: string;
	principalType: BindingPrincipalType;
	principalId: string;
	roleId: string;
	roleName: string;
	scope: ScopeRef;
	expiresAt: number | null;
	reason: string | null;
	createdBy: string;
	createdAt: number;
}

/** A dry run (IAM.md §9.3): what one principal gains or loses from a draft change. */
export interface IamSimulationDraft {
	/** The principal whose access is being asked about. */
	sample: { principalType: 'user' | 'serviceAccount'; principalId: string };
	/** Either a new binding for the sample, or a custom role's replacement permissions. */
	change:
		| {
				kind: 'binding';
				roleId: string;
				scope: ScopeRef;
				expiresAt?: number | null;
				condition?: Condition | null;
			}
		| { kind: 'role'; roleId: string; permissions: readonly string[] };
}

/** One permission whose decision flips at a resource. */
export interface IamSimulationChange {
	permission: Permission;
	resource: ResourceRef;
	before: boolean;
	after: boolean;
	change: 'granted' | 'revoked';
	beforeVia?: string;
	afterVia?: string;
}

export interface IamSimulationResult {
	sample: IamSimulationDraft['sample'];
	draft: IamSimulationDraft['change'];
	/** Every decision that flips, at the resource the draft applies to. */
	changes: IamSimulationChange[];
	/** Distinct permissions gained and lost, for a compact editor summary. */
	added: Permission[];
	removed: Permission[];
	/** Always false: a simulation reads, it never writes. */
	applied: false;
}

export interface WhoCanEntry {
	principalType: BindingPrincipalType;
	principalId: string;
	/** The binding that allowed it, or null when a group path was used. */
	via: string | null;
}

export interface GroupView {
	id: string;
	name: string;
	description: string;
	source: string;
	members: number;
}

export class IamService {
	readonly #sqlite: Database;
	readonly #cache = new Map<string, CompiledGrants>();
	#builtInsSeeded = false;

	constructor(private readonly ctx: CoreContext) {
		this.#sqlite = ctx.sqlite;
	}

	// ---------------------------------------------------------------- reads

	/** Compile a principal's grants. Cached by `(principal, org, iamVersion)` (IAM.md §5.2). */
	compiledFor(principal: Principal): CompiledGrants {
		// A named system principal carries its fixed permission set (IAM.md I3); it has no bindings.
		if (principal.kind === 'system') {
			return compileGrants({
				orgId: principal.orgId,
				bindings: [
					{
						id: `system:${principal.userId}`,
						roleId: 'system',
						permissions: [...principal.permissions],
						scope: { type: 'org' },
					},
				],
				restriction: principal.restriction,
			});
		}
		this.ensureMemberBinding(principal);
		const version = this.version(principal.orgId);
		const type = bindingType(principal);
		// A credential can only narrow its principal's bindings (IAM.md §2). A scoped key or an
		// MCP consent contributes its effective permissions; an STS/workload token contributes the
		// `scope`/`resources` it was minted with. Every kind may carry a restriction.
		const restriction = this.restrictionFor(principal);
		const key = `${type}:${principal.userId}:${principal.orgId}:${version}${restrictionKey(restriction)}`;
		const cached = this.#cache.get(key);
		if (cached) return cached;

		const rows = this.bindingRows(principal.orgId, type, principal.userId);

		const bindings = this.bindingsFromRows(principal.orgId, rows);
		// Compatibility until I2 has seeded bindings everywhere: a principal with no binding rows
		// at all keeps exactly the permissions its legacy role/grant already gave it. Once the
		// member endpoints write bindings, this branch is unreachable and gets deleted.
		if (bindings.length === 0 && version === 0 && principal.permissions.size > 0) {
			bindings.push({
				id: 'compat:legacy-role',
				roleId: principal.role,
				permissions: [...principal.permissions],
				scope: { type: 'org' },
			});
		}

		const compiled = compileGrants({
			orgId: principal.orgId,
			bindings,
			guardrails: this.guardrails(principal, type),
			restriction,
		});
		this.#cache.set(key, compiled);
		return compiled;
	}

	/** `all` when an org binding covers the permission; otherwise the project (or environment) ids. */
	scopeFilter(
		principal: Principal,
		permission: Permission,
		by: 'project' | 'environment' = 'project',
	): 'all' | Set<string> {
		const grants = this.compiledFor(principal).index.get(permission) ?? [];
		if (grants.some((grant) => grant.scope.type === 'org')) return 'all';
		const ids = new Set<string>();
		for (const grant of grants) {
			const scope = grant.scope;
			if (scope.type === 'project') ids.add(scope.id);
			else if (scope.type === 'environment')
				ids.add(by === 'environment' ? scope.id : scope.projectId);
			else if (scope.type !== 'platform' && scope.type !== 'org' && scope.projectId)
				ids.add(scope.projectId);
		}
		return ids;
	}

	can(principal: Principal, permission: Permission, resource: ResourceRef): boolean {
		return this.decide(principal, permission, resource).allow;
	}

	/** Throws `ForbiddenError` with the engine's reason in the message when the decision is deny. */
	require(principal: Principal, permission: Permission, resource: ResourceRef): void {
		const decision = this.decide(principal, permission, resource);
		if (!decision.allow)
			throw new ForbiddenError(permission, decision.reason, decision.via);
		// Step-up (STEP-UP.md §3, §6): a session-backed person must have verified recently enough
		// for a sensitive permission. Kept behind the flag while no verification UI exists, and
		// limited to `user` principals: tokens cannot show a dialog and follow §7's token rule.
		if (stepUpEnabled() && stepUpAppliesTo(principal) && stepUpLevel(permission) !== 'none')
			requireStepUp(principal, permission, this.ctx.now());
	}

	explain(principal: Principal, permission: Permission, resource: ResourceRef): Decision {
		return this.decide(principal, permission, resource);
	}

	/**
	 * Who can do this, for the "who can access this?" view (IAM.md I12). Expands group bindings to
	 * their members and reconciles every member's base role first, so the answer matches a check.
	 */
	whoCan(orgId: string, permission: Permission, resource: ResourceRef): WhoCanEntry[] {
		this.syncMembers(orgId);
		const rows = this.#sqlite
			.query<BindingRow, [string]>(
				'SELECT * FROM iam_bindings WHERE org_id = ? OR org_id IS NULL',
			)
			.all(orgId);
		const membersByGroup = new Map<string, string[]>();
		for (const row of this.#sqlite
			.query<{ group_id: string; user_id: string }, [string]>(
				`SELECT m.group_id, m.user_id FROM iam_group_members m
				 JOIN iam_groups g ON g.id = m.group_id WHERE g.org_id = ?`,
			)
			.all(orgId)) {
			const list = membersByGroup.get(row.group_id) ?? [];
			list.push(row.user_id);
			membersByGroup.set(row.group_id, list);
		}
		const candidates = new Map<string, { type: BindingPrincipalType; id: string; rows: BindingRow[] }>();
		const add = (type: BindingPrincipalType, id: string, row: BindingRow) => {
			const key = `${type}:${id}`;
			const entry = candidates.get(key) ?? { type, id, rows: [] };
			entry.rows.push(row);
			candidates.set(key, entry);
		};
		for (const row of rows) {
			const type = row.principal_type as BindingPrincipalType;
			if (type === 'group') {
				for (const userId of membersByGroup.get(row.principal_id) ?? [])
					add('user', userId, row);
			} else add(type, row.principal_id, row);
		}
		const out: WhoCanEntry[] = [];
		for (const candidate of candidates.values()) {
			const decision = authorize(
				compileGrants({
					orgId,
					bindings: this.bindingsFromRows(orgId, candidate.rows),
					guardrails: this.guardrails(
						{ kind: candidate.type === 'user' ? 'user' : 'serviceAccount', userId: candidate.id, orgId } as Principal,
						candidate.type,
					),
				}),
				{ permission, resource, context: { now: this.ctx.now() } },
			);
			if (decision.allow)
				out.push({ principalType: candidate.type, principalId: candidate.id, via: decision.via ?? null });
		}
		return out;
	}

	/**
	 * Dry-run a draft binding or custom-role edit for one principal (IAM.md §9.3, I12). It compiles
	 * the sample's current bindings, applies the change in memory, and reports the decisions that
	 * flip. Nothing is written and `iamVersion` does not move.
	 *
	 * A binding draft is a direct grant to the sample and is evaluated at the draft's scope. A role
	 * draft replaces a custom role's permissions for every binding of that role the sample holds;
	 * built-in roles live in code and are rejected. Guardrails and conditions still apply, so the
	 * diff is the decision the engine would reach, not a promise that the write is allowed.
	 */
	simulate(principal: Principal, draft: IamSimulationDraft): IamSimulationResult {
		this.require(principal, 'iam:read', { type: 'org' });
		const orgId = principal.orgId;
		const { sample, change } = draft;
		if (sample.principalType !== 'user' && sample.principalType !== 'serviceAccount')
			throw new ValidationError('A simulation samples a user or a service account.');
		const sampleId = sample.principalId.trim();
		if (!sampleId) throw new ValidationError('A simulation needs a sample principal id.');

		const type: BindingPrincipalType = sample.principalType;
		const bindings = this.bindingsFromRows(
			orgId,
			this.bindingRows(orgId, type, sampleId),
		);
		const samplePrincipal: Principal = {
			kind: type === 'user' ? 'user' : 'serviceAccount',
			userId: sampleId,
			orgId,
			role: 'guest',
			permissions: new Set<Permission>(),
		};
		const guardrails = this.guardrails(samplePrincipal, type);
		const before = compileGrants({ orgId, bindings, guardrails });

		let afterBindings: Binding[];
		let resources: ResourceRef[];
		if (change.kind === 'binding') {
			const rolePermissions = this.rolePermissions(orgId, change.roleId);
			if (!rolePermissions) throw new ValidationError(`Unknown role "${change.roleId}".`);
			validateSimulatedScope(change.scope);
			if (change.expiresAt != null && change.expiresAt <= this.ctx.now())
				throw new ValidationError('An expiry must be in the future.');
			afterBindings = [
				...bindings,
				{
					id: 'simulated:binding',
					roleId: change.roleId,
					permissions: rolePermissions,
					scope: change.scope,
					expiresAt: change.expiresAt ?? null,
					condition: change.condition ?? null,
				},
			];
			resources = [resourceForScope(change.scope)];
		} else {
			const role = this.listRoles(orgId).find((entry) => entry.id === change.roleId);
			if (!role) throw new ValidationError(`Unknown role "${change.roleId}".`);
			if (role.builtIn)
				throw new ValidationError(
					'Built-in roles are defined in code; simulate a binding instead of editing one.',
				);
			const permissions = [...new Set(change.permissions.map((permission) => permission.trim()))];
			if (permissions.length === 0)
				throw new ValidationError('A role needs at least one permission.');
			for (const permission of permissions)
				if (!isPermission(permission))
					throw new ValidationError(`"${permission}" is not a permission in the catalog.`);
			const next = permissions as Permission[];
			afterBindings = bindings.map((binding) =>
				binding.roleId === change.roleId ? { ...binding, permissions: next } : binding,
			);
			resources = [
				...new Map(
					bindings
						.filter((binding) => binding.roleId === change.roleId)
						.map((binding) => [JSON.stringify(binding.scope), resourceForScope(binding.scope)] as const),
				).values(),
			];
		}

		const after = compileGrants({ orgId, bindings: afterBindings, guardrails });
		const permissions = [...new Set([...before.index.keys(), ...after.index.keys()])].sort();
		const context = { now: this.ctx.now(), credential: 'session' as const };
		const changes: IamSimulationChange[] = [];
		for (const resource of resources) {
			for (const permission of permissions) {
				const prior = authorize(before, { permission, resource, context });
				const next = authorize(after, { permission, resource, context });
				if (prior.allow === next.allow) continue;
				changes.push({
					permission,
					resource,
					before: prior.allow,
					after: next.allow,
					change: next.allow ? 'granted' : 'revoked',
					beforeVia: prior.via,
					afterVia: next.via,
				});
			}
		}
		return {
			sample: { principalType: sample.principalType, principalId: sampleId },
			draft: change,
			changes,
			added: [...new Set(changes.filter((entry) => entry.change === 'granted').map((entry) => entry.permission))],
			removed: [...new Set(changes.filter((entry) => entry.change === 'revoked').map((entry) => entry.permission))],
			applied: false,
		};
	}

	/** Create the org binding a member's base role stands for, for every member not yet bound. */
	syncMembers(orgId: string): number {
		let members: Array<{ userId: string }> = [];
		try {
			members = this.#sqlite
				.query<{ userId: string }, [string]>('SELECT userId FROM member WHERE organizationId = ?')
				.all(orgId);
		} catch {
			return 0;
		}
		let added = 0;
		for (const member of members) added += this.ensureMemberBindingFor(orgId, member.userId) ? 1 : 0;
		return added;
	}

	private decide(principal: Principal, permission: Permission, resource: ResourceRef): Decision {
		return authorize(this.compiledFor(principal), {
			permission,
			resource,
			context: { now: this.ctx.now(), credential: principal.credential },
		});
	}

	version(orgId: string): number {
		const row = this.#sqlite
			.query<{ version: number }, [string]>('SELECT version FROM iam_state WHERE org_id = ?')
			.get(orgId);
		return row?.version ?? 0;
	}

	/** Bump `iamVersion` and drop the compile cache. Call inside the write's transaction. */
	touch(orgId: string): number {
		const now = this.ctx.now();
		const row = this.#sqlite
			.query<{ version: number }, [string, number]>(
				`INSERT INTO iam_state (org_id, version, updated_at) VALUES (?, 1, ?)
				 ON CONFLICT (org_id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at
				 RETURNING version`,
			)
			.get(orgId, now);
		this.#cache.clear();
		return row?.version ?? 1;
	}

	// ---------------------------------------------------------------- roles

	listRoles(orgId: string): RoleView[] {
		this.ensureBuiltIns();
		const builtIns = (Object.keys(roles) as Role[]).map((role) => ({
			id: role,
			name: role,
			description: BUILT_IN_DESCRIPTIONS[role],
			permissions: roles[role] as readonly Permission[],
			builtIn: true,
		}));
		const custom = this.#sqlite
			.query<RoleRow, [string]>('SELECT * FROM iam_roles WHERE org_id = ? ORDER BY name')
			.all(orgId)
			.map((row) => ({
				id: row.id,
				name: row.name,
				description: row.description,
				permissions: parsePermissions(row.permissions_json),
				builtIn: false,
			}));
		return [...builtIns, ...custom];
	}

	createRole(
		principal: Principal,
		input: { name: string; description?: string; permissions: readonly string[] },
	): RoleView {
		this.requirePermission(principal, 'iam:manage-roles');
		const name = input.name.trim().toLowerCase();
		if (!ROLE_NAME.test(name))
			throw new ValidationError('A role name is 2–40 lowercase letters, digits or single hyphens.');
		const permissions = [...new Set(input.permissions)];
		if (permissions.length === 0) throw new ValidationError('A role needs at least one permission.');
		for (const permission of permissions)
			if (!isPermission(permission) || permission.includes('*'))
				throw new ValidationError(`"${permission}" is not a permission in the catalog.`);
		const taken = this.#sqlite
			.query<{ id: string }, [string, string]>('SELECT id FROM iam_roles WHERE org_id = ? AND name = ?')
			.get(principal.orgId, name);
		if (taken || name in roles) throw new ConflictError(`A role named "${name}" already exists.`);
		this.ensureBuiltIns();
		const id = newId('role_');
		const now = this.ctx.now();
		this.#sqlite.transaction(() => {
			this.#sqlite.run(
				`INSERT INTO iam_roles
				   (id, org_id, name, description, permissions_json, built_in, created_by, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
				[id, principal.orgId, name, input.description ?? '', JSON.stringify(permissions), principal.userId, now, now],
			);
			this.touch(principal.orgId);
		})();
		this.ctx.audit.record({
			principal,
			action: 'iam.role.create',
			resource: 'iam_role',
			resourceId: id,
			args: { name, permissions },
			result: 'ok',
		});
		return {
			id,
			name,
			description: input.description ?? '',
			permissions: permissions as Permission[],
			builtIn: false,
		};
	}

	deleteRole(principal: Principal, roleId: string): void {
		this.requirePermission(principal, 'iam:manage-roles');
		const row = this.#sqlite
			.query<RoleRow, [string, string]>('SELECT * FROM iam_roles WHERE id = ? AND org_id = ?')
			.get(roleId, principal.orgId);
		if (!row) throw new NotFoundError('Role');
		if (row.built_in) throw new ValidationError('Built-in roles cannot be deleted.');
		const bound = this.#sqlite
			.query('SELECT 1 FROM iam_bindings WHERE org_id = ? AND role_id = ? LIMIT 1')
			.get(principal.orgId, roleId);
		if (bound) throw new ConflictError('Unbind this role from every principal before deleting it.');
		this.#sqlite.transaction(() => {
			this.#sqlite.run('DELETE FROM iam_roles WHERE id = ?', [roleId]);
			this.touch(principal.orgId);
		})();
		this.ctx.audit.record({
			principal,
			action: 'iam.role.delete',
			resource: 'iam_role',
			resourceId: roleId,
			result: 'ok',
		});
	}

	// ---------------------------------------------------------------- bindings

	bind(
		principal: Principal,
		input: {
			principalType: BindingPrincipalType;
			principalId: string;
			roleId: string;
			scope: ScopeRef;
			condition?: Condition | null;
			expiresAt?: number | null;
			reason?: string;
		},
	): BindingView {
		this.requirePermission(principal, 'iam:manage-bindings');
		if (!PRINCIPAL_TYPES.includes(input.principalType))
			throw new ValidationError('A binding targets a user, a group or a service account.');
		if (!this.rolePermissions(principal.orgId, input.roleId))
			throw new ValidationError(`Unknown role "${input.roleId}".`);
		if (input.expiresAt != null && input.expiresAt <= this.ctx.now())
			throw new ValidationError('An expiry must be in the future.');
		if (input.scope.type !== 'platform' && input.scope.type !== 'org' && !input.scope.id)
			throw new ValidationError('A scoped binding needs a resource id.');
		if (input.scope.type === 'environment' && !input.scope.projectId)
			throw new ValidationError('An environment binding needs its project.');
		if (input.scope.type === 'platform' && principal.platformAdmin !== true)
			throw new ValidationError('Platform bindings are written by a platform admin, not an org.');

		const orgId = input.scope.type === 'platform' ? null : principal.orgId;
		const row = scopeToRow(input.scope);
		const id = newId('bind_');
		const now = this.ctx.now();
		this.#sqlite.transaction(() => {
			this.#sqlite.run(
				`INSERT INTO iam_bindings
				   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, scope_parent_id,
				    condition_json, expires_at, reason, created_by, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					orgId,
					input.principalType,
					input.principalId,
					input.roleId,
					row.type,
					row.id,
					row.parentId,
					input.condition ? JSON.stringify(input.condition) : null,
					input.expiresAt ?? null,
					input.reason ?? null,
					principal.userId,
					now,
				],
			);
			if (principal.orgId) this.touch(principal.orgId);
		})();
		this.ctx.audit.record({
			principal,
			action: 'iam.binding.create',
			resource: 'iam_binding',
			resourceId: id,
			args: {
				principalType: input.principalType,
				principalId: input.principalId,
				roleId: input.roleId,
				scope: input.scope,
			},
			result: 'ok',
		});
		return {
			id,
			principalType: input.principalType,
			principalId: input.principalId,
			roleId: input.roleId,
			roleName: input.roleId,
			scope: input.scope,
			expiresAt: input.expiresAt ?? null,
			reason: input.reason ?? null,
			createdBy: principal.userId,
			createdAt: now,
		};
	}

	unbind(principal: Principal, bindingId: string): void {
		this.requirePermission(principal, 'iam:manage-bindings');
		const row = this.#sqlite
			.query<BindingRow, [string, string]>(
				'SELECT * FROM iam_bindings WHERE id = ? AND (org_id = ? OR org_id IS NULL)',
			)
			.get(bindingId, principal.orgId);
		if (!row) throw new NotFoundError('Binding');
		if (row.org_id === null)
			throw new ValidationError('A platform binding is removed by a platform admin.');
		this.#sqlite.transaction(() => {
			this.#sqlite.run('DELETE FROM iam_bindings WHERE id = ?', [bindingId]);
			this.touch(principal.orgId);
		})();
		this.ctx.audit.record({
			principal,
			action: 'iam.binding.delete',
			resource: 'iam_binding',
			resourceId: bindingId,
			result: 'ok',
		});
	}

	/**
	 * Give a user project-scope access as a guest (IAM.md §8.2). This runs when a project
	 * invitation is accepted, on the invitee's behalf, so it has no acting principal; the inviter
	 * is recorded as `created_by`. The caller has already checked the invite.
	 */
	grantGuestProject(input: {
		orgId: string;
		userId: string;
		projectId: string;
		roleId: 'deployer' | 'viewer';
		createdBy: string;
	}): string {
		if (input.roleId !== 'deployer' && input.roleId !== 'viewer')
			throw new ValidationError('A guest can be a deployer or a viewer on a project.');
		const project = this.#sqlite
			.query<{ id: string }, [string, string]>('SELECT id FROM projects WHERE id = ? AND org_id = ?')
			.get(input.projectId, input.orgId);
		if (!project) throw new NotFoundError('Project');
		const id = newId('bind_');
		const now = this.ctx.now();
		this.#sqlite.transaction(() => {
			this.#sqlite.run(
				`INSERT INTO iam_bindings
				   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, scope_parent_id,
				    condition_json, expires_at, reason, created_by, created_at)
				 VALUES (?, ?, 'user', ?, ?, 'project', ?, NULL, NULL, NULL, NULL, ?, ?)`,
				[id, input.orgId, input.userId, input.roleId, input.projectId, input.createdBy, now],
			);
			this.touch(input.orgId);
		})();
		return id;
	}

	/** Change a user's project binding from the project Access tab (`member:update-role`). */
	updateProjectBindingRole(
		principal: Principal,
		bindingId: string,
		projectId: string,
		roleId: 'deployer' | 'viewer',
	): void {
		if (roleId !== 'deployer' && roleId !== 'viewer')
			throw new ValidationError('A project member can be a deployer or a viewer.');
		this.require(principal, 'member:update-role', { type: 'project', id: projectId });
		const row = this.#sqlite
			.query<BindingRow, [string, string, string]>(
				`SELECT * FROM iam_bindings
				  WHERE id = ? AND org_id = ? AND principal_type = 'user'
				    AND scope_type = 'project' AND scope_id = ?`,
			)
			.get(bindingId, principal.orgId, projectId);
		if (!row) throw new NotFoundError('Project member');
		if (row.role_id === roleId) return;
		this.#sqlite.transaction(() => {
			this.#sqlite.run('UPDATE iam_bindings SET role_id = ? WHERE id = ?', [roleId, bindingId]);
			this.touch(principal.orgId);
		})();
		this.ctx.audit.record({
			principal,
			action: 'iam.binding.update',
			resource: 'iam_binding',
			resourceId: bindingId,
			args: { from: row.role_id, to: roleId, projectId },
			result: 'ok',
		});
	}

	/** Remove a user's project binding from the project Access tab (`member:remove`). */
	removeProjectBinding(principal: Principal, bindingId: string, projectId: string): void {
		this.require(principal, 'member:remove', { type: 'project', id: projectId });
		const row = this.#sqlite
			.query<BindingRow, [string, string, string]>(
				`SELECT * FROM iam_bindings
				  WHERE id = ? AND org_id = ? AND principal_type = 'user'
				    AND scope_type = 'project' AND scope_id = ?`,
			)
			.get(bindingId, principal.orgId, projectId);
		if (!row) throw new NotFoundError('Project member');
		this.#sqlite.transaction(() => {
			this.#sqlite.run('DELETE FROM iam_bindings WHERE id = ?', [bindingId]);
			this.touch(principal.orgId);
		})();
		this.ctx.audit.record({
			principal,
			action: 'iam.binding.delete',
			resource: 'iam_binding',
			resourceId: bindingId,
			args: { projectId, role: row.role_id },
			result: 'ok',
		});
	}

	/** Drop every binding a user holds in an org (used when a member, including a guest, is removed). */
	removeUserBindings(orgId: string, userId: string): number {
		let changes = 0;
		this.#sqlite.transaction(() => {
			const result = this.#sqlite.run(
				"DELETE FROM iam_bindings WHERE org_id = ? AND principal_type = 'user' AND principal_id = ?",
				[orgId, userId],
			);
			changes = result.changes;
			if (changes > 0) this.touch(orgId);
		})();
		return changes;
	}

	listBindings(orgId: string): BindingView[] {
		return this.#sqlite
			.query<BindingRow, [string]>('SELECT * FROM iam_bindings WHERE org_id = ? ORDER BY created_at DESC')
			.all(orgId)
			.flatMap((row) => {
				const scope = scopeFromRow(row);
				if (!scope) return [];
				return [
					{
						id: row.id,
						principalType: row.principal_type as BindingPrincipalType,
						principalId: row.principal_id,
						roleId: row.role_id,
						roleName: row.role_id,
						scope,
						expiresAt: row.expires_at,
						reason: row.reason,
						createdBy: row.created_by,
						createdAt: row.created_at,
					},
				];
			});
	}

	// ---------------------------------------------------------------- groups

	listGroups(orgId: string): GroupView[] {
		return this.#sqlite
			.query<GroupRow & { members: number }, [string]>(
				`SELECT g.*, (SELECT COUNT(*) FROM iam_group_members m WHERE m.group_id = g.id) AS members
				 FROM iam_groups g WHERE g.org_id = ? ORDER BY g.name`,
			)
			.all(orgId)
			.map((row) => ({
				id: row.id,
				name: row.name,
				description: row.description,
				source: row.source,
				members: row.members,
			}));
	}

	createGroup(principal: Principal, input: { name: string; description?: string }): GroupView {
		this.requirePermission(principal, 'iam:manage-groups');
		const name = input.name.trim();
		if (!ROLE_NAME.test(name.toLowerCase()))
			throw new ValidationError('A group name is 2–40 letters, digits or single hyphens.');
		const taken = this.#sqlite
			.query<{ id: string }, [string, string]>('SELECT id FROM iam_groups WHERE org_id = ? AND name = ?')
			.get(principal.orgId, name);
		if (taken) throw new ConflictError(`A group named "${name}" already exists.`);
		const id = newId('grp_');
		const now = this.ctx.now();
		this.#sqlite.transaction(() => {
			this.#sqlite.run(
				`INSERT INTO iam_groups (id, org_id, name, description, source, created_by, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'local', ?, ?, ?)`,
				[id, principal.orgId, name, input.description ?? '', principal.userId, now, now],
			);
			this.touch(principal.orgId);
		})();
		this.ctx.audit.record({
			principal,
			action: 'iam.group.create',
			resource: 'iam_group',
			resourceId: id,
			args: { name },
			result: 'ok',
		});
		return { id, name, description: input.description ?? '', source: 'local', members: 0 };
	}

	addGroupMember(principal: Principal, groupId: string, userId: string): void {
		this.requirePermission(principal, 'iam:manage-groups');
		const group = this.#sqlite
			.query<GroupRow, [string, string]>('SELECT * FROM iam_groups WHERE id = ? AND org_id = ?')
			.get(groupId, principal.orgId);
		if (!group) throw new NotFoundError('Group');
		if (group.source !== 'local')
			throw new ValidationError(`This group is managed by ${group.source}.`);
		this.#sqlite.transaction(() => {
			this.#sqlite.run(
				`INSERT INTO iam_group_members (group_id, user_id, source, created_at) VALUES (?, ?, 'local', ?)
				 ON CONFLICT (group_id, user_id) DO NOTHING`,
				[groupId, userId, this.ctx.now()],
			);
			this.touch(principal.orgId);
		})();
		this.ctx.audit.record({
			principal,
			action: 'iam.group.member.add',
			resource: 'iam_group',
			resourceId: groupId,
			args: { userId },
			result: 'ok',
		});
	}

	removeGroupMember(principal: Principal, groupId: string, userId: string): void {
		this.requirePermission(principal, 'iam:manage-groups');
		const group = this.#sqlite
			.query<GroupRow, [string, string]>('SELECT * FROM iam_groups WHERE id = ? AND org_id = ?')
			.get(groupId, principal.orgId);
		if (!group) throw new NotFoundError('Group');
		if (group.source !== 'local')
			throw new ValidationError(`This group is managed by ${group.source}.`);
		this.#sqlite.transaction(() => {
			this.#sqlite.run('DELETE FROM iam_group_members WHERE group_id = ? AND user_id = ?', [
				groupId,
				userId,
			]);
			this.touch(principal.orgId);
		})();
	}

	// ---------------------------------------------------------------- internals

	/**
	 * The narrowing a principal's credential imposes. A scoped key or an MCP consent is capped by
	 * the effective permissions it carries; an explicit `principal.restriction` (an STS token's
	 * `scope`/`resources`, a workload token's limits) is intersected with that cap. Any other kind
	 * with no restriction is uncapped.
	 */
	private restrictionFor(principal: Principal): Restriction | undefined {
		// A guest's capabilities come from project bindings, not the (empty) guest role. An MCP
		// token's permission set was intersected with that role when it was built, so deriving a
		// ceiling from it would cap a guest token to nothing and hide the very bindings that grant
		// its access. The compiled bindings are the grant; an explicit restriction still narrows them.
		const derived: Restriction | undefined =
			(principal.kind === 'apiKey' || principal.kind === 'mcp') && principal.role !== 'guest'
				? { permissions: [...principal.permissions] as Permission[] }
				: undefined;
		const own = principal.restriction;
		if (!own) return derived;

		let permissions: Permission[] | undefined;
		if (own.permissions !== undefined) {
			permissions = derived
				? own.permissions.filter((permission) => derived.permissions?.includes(permission))
				: [...own.permissions];
		} else {
			permissions = derived?.permissions as Permission[] | undefined;
		}
		const resources = own.resources ? [...own.resources] : undefined;
		return {
			...(permissions !== undefined ? { permissions } : {}),
			...(resources !== undefined ? { resources } : {}),
		};
	}

	/** The binding rows that apply to one principal, including its group bindings. */
	private bindingRows(orgId: string, type: BindingPrincipalType, userId: string): BindingRow[] {
		return this.#sqlite
			.query<BindingRow, [string, string | null, string, string]>(
				`SELECT * FROM iam_bindings
				 WHERE (org_id = ? OR org_id IS NULL)
				   AND (
				     (principal_type = ? AND principal_id = ?)
				     OR (principal_type = 'group' AND principal_id IN (
				       SELECT group_id FROM iam_group_members WHERE user_id = ?
				     ))
				   )`,
			)
			.all(orgId, type, userId, userId);
	}

	private bindingsFromRows(orgId: string, rows: readonly BindingRow[]): Binding[] {
		return rows.flatMap((row) => {
			const scope = scopeFromRow(row);
			const permissions = this.rolePermissions(row.org_id ?? orgId, row.role_id);
			if (!scope || !permissions) return [];
			return [
				{
					id: row.id,
					roleId: row.role_id,
					permissions,
					scope,
					expiresAt: row.expires_at,
					condition: parseCondition(row.condition_json),
				} satisfies Binding,
			];
		});
	}

	/**
	 * A user's `member.role` becomes an org binding the first time the engine sees them, when they
	 * have none (IAM.md §4). I2 replaces the member endpoints so this disappears.
	 */
	private ensureMemberBinding(principal: Principal): void {
		if (bindingType(principal) !== 'user') return;
		this.ensureMemberBindingFor(principal.orgId, principal.userId);
	}

	private ensureMemberBindingFor(orgId: string, userId: string): boolean {
		const existing = this.#sqlite
			.query(
				`SELECT 1 FROM iam_bindings
				  WHERE org_id = ? AND principal_type = 'user' AND principal_id = ? AND scope_type = 'org'
				  LIMIT 1`,
			)
			.get(orgId, userId);
		if (existing) return false;
		let role: string | undefined;
		try {
			role = this.#sqlite
				.query<{ role: string }, [string, string]>(
					'SELECT role FROM member WHERE organizationId = ? AND userId = ?',
				)
				.get(orgId, userId)?.role;
		} catch {
			// Better Auth tables are absent in a bare core test or before boot.
			return false;
		}
		// A guest is project-only (IAM.md §8.2). Their `member` row exists so sign-in resolves an org,
		// but syncing it to an org binding would grant the (empty) guest role at org scope and hide
		// their real access, which comes from project bindings created when the invitation is accepted.
		if (!role || role === 'guest' || !(role in roles)) return false;
		this.ensureBuiltIns();
		this.#sqlite.transaction(() => {
			this.#sqlite.run(
				`INSERT INTO iam_bindings
				   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, scope_parent_id,
				    created_by, created_at)
				 VALUES (?, ?, 'user', ?, ?, 'org', NULL, NULL, ?, ?)`,
				[newId('bind_'), orgId, userId, role, 'system:member-sync', this.ctx.now()],
			);
			this.touch(orgId);
		})();
		return true;
	}

	private ensureBuiltIns(): void {
		if (this.#builtInsSeeded) return;
		const now = this.ctx.now();
		this.#sqlite.transaction(() => {
			for (const [role, permissions] of Object.entries(roles)) {
				this.#sqlite.run(
					`INSERT OR IGNORE INTO iam_roles
					   (id, org_id, name, description, permissions_json, built_in, created_at, updated_at)
					 VALUES (?, NULL, ?, ?, ?, 1, ?, ?)`,
					[
						role,
						role,
						BUILT_IN_DESCRIPTIONS[role as Role],
						JSON.stringify(permissions),
						now,
						now,
					],
				);
			}
		})();
		this.#builtInsSeeded = true;
	}

	/** Built-in roles come from code; custom ones from `iam_roles`. */
	private rolePermissions(orgId: string, roleId: string): readonly Permission[] | undefined {
		if (roleId in roles) return roles[roleId as Role] as readonly Permission[];
		const row = this.#sqlite
			.query<{ permissions_json: string }, [string, string]>(
				'SELECT permissions_json FROM iam_roles WHERE id = ? AND org_id = ?',
			)
			.get(roleId, orgId);
		if (!row) return undefined;
		return parsePermissions(row.permissions_json);
	}

	private guardrails(principal: Principal, type: BindingPrincipalType): Guardrail[] {
		let rows: GuardrailRow[];
		try {
			rows = this.#sqlite
				.query<GuardrailRow, [string]>(
					'SELECT * FROM iam_guardrails WHERE enabled = 1 AND (org_id = ? OR org_id IS NULL)',
				)
				.all(principal.orgId);
		} catch {
			return [];
		}
		const groupIds = new Set(
			this.#sqlite
				.query<{ group_id: string }, [string]>('SELECT group_id FROM iam_group_members WHERE user_id = ?')
				.all(principal.userId)
				.map((row) => row.group_id),
		);
		return rows.flatMap((row) => {
			if (!selectorMatches(row.principal_selector_json, type, principal.userId, groupIds)) return [];
			const scope =
				row.scope_type === null
					? undefined
					: scopeFromRow({
							scope_type: row.scope_type,
							scope_id: row.scope_id,
							scope_parent_id: row.scope_parent_id,
						});
			if (row.scope_type !== null && !scope) return [];
			return [
				{
					id: row.id,
					permissions: parsePatterns(row.permissions_json),
					scope,
					condition: parseCondition(row.condition_json) ?? undefined,
				} satisfies Guardrail,
			];
		});
	}

	private requirePermission(principal: Principal, permission: Permission): void {
		if (!principal.permissions.has(permission)) throw new ForbiddenError(permission);
	}
}

const BUILT_IN_DESCRIPTIONS: Record<Role, string> = {
	owner: 'Everything, including deleting or transferring the org and managing owners and guardrails.',
	admin: 'Everything except deleting or transferring the org, managing owners, and editing guardrails.',
	deployer: 'Deploy and run projects, databases, storage and pipelines; no org administration.',
	viewer: 'Read-only access to the org and its projects.',
	guest: 'Project-only access from bindings; no organisation-wide permissions.',
};

/** The cache key fragment for a restriction: sorted, so insertion order never splits the cache. */
function restrictionKey(restriction: Restriction | undefined): string {
	if (!restriction) return '';
	const permissions = [...(restriction.permissions ?? [])].sort().join(',');
	const resources = [...(restriction.resources ?? [])].sort().join(',');
	return `:${permissions}|${resources}`;
}

function bindingType(principal: Principal): BindingPrincipalType {
	if (principal.kind === 'user' || principal.kind === 'apiKey' || principal.kind === 'mcp') return 'user';
	if (principal.kind === 'system') return 'user';
	return 'serviceAccount';
}

function parsePermissions(json: string): Permission[] {
	return parsePatterns(json).filter(isPermission);
}

/** Guardrails may name wildcards (`resource:*`, `all`), so they keep the strings as written. */
function parsePatterns(json: string): string[] {
	try {
		const value: unknown = JSON.parse(json);
		if (!Array.isArray(value)) return [];
		return value.filter((entry): entry is string => typeof entry === 'string');
	} catch {
		return [];
	}
}

function parseCondition(json: string | null): Condition | null {
	if (!json) return null;
	try {
		const value: unknown = JSON.parse(json);
		if (!value || typeof value !== 'object' || typeof (value as { op?: unknown }).op !== 'string')
			return null;
		return value as Condition;
	} catch {
		// Malformed JSON on a binding denies rather than allows.
		return { op: '__invalid' } as unknown as Condition;
	}
}

function selectorMatches(
	json: string,
	type: BindingPrincipalType,
	principalId: string,
	groupIds: ReadonlySet<string>,
): boolean {
	let selector: { principalTypes?: unknown; principalIds?: unknown; groupIds?: unknown };
	try {
		selector = JSON.parse(json) as typeof selector;
	} catch {
		return false;
	}
	const types = Array.isArray(selector.principalTypes) ? selector.principalTypes : undefined;
	if (types && !types.includes(type)) return false;
	const principals = Array.isArray(selector.principalIds) ? selector.principalIds : undefined;
	if (principals && !principals.includes(principalId)) return false;
	const groups = Array.isArray(selector.groupIds) ? selector.groupIds : undefined;
	if (groups && !groups.some((id) => groupIds.has(String(id)))) return false;
	return true;
}

/** The resource a scope applies to, for evaluating a simulated grant. */
function resourceForScope(scope: ScopeRef): ResourceRef {
	switch (scope.type) {
		case 'platform':
			return { type: 'platform' };
		case 'org':
			return { type: 'org' };
		case 'project':
			return { type: 'project', id: scope.id };
		case 'environment':
			return { type: 'environment', id: scope.id, projectId: scope.projectId };
		default:
			return { type: scope.type, id: scope.id, projectId: scope.projectId };
	}
}

/** The same shape rules `bind` enforces, so a simulation never reports a draft the write would reject. */
function validateSimulatedScope(scope: ScopeRef): void {
	if (scope.type === 'platform')
		throw new ValidationError('Platform bindings are written by a platform admin, not simulated as an org draft.');
	if (scope.type !== 'org' && !scope.id)
		throw new ValidationError('A scoped binding needs a resource id.');
	if (scope.type === 'environment' && !scope.projectId)
		throw new ValidationError('An environment binding needs its project.');
}

function scopeToRow(scope: ScopeRef): { type: string; id: string | null; parentId: string | null } {
	switch (scope.type) {
		case 'platform':
		case 'org':
			return { type: scope.type, id: null, parentId: null };
		case 'project':
			return { type: 'project', id: scope.id, parentId: null };
		case 'environment':
			return { type: 'environment', id: scope.id, parentId: scope.projectId };
		default:
			return { type: scope.type, id: scope.id, parentId: scope.projectId ?? null };
	}
}

function scopeFromRow(row: {
	scope_type: string;
	scope_id: string | null;
	scope_parent_id: string | null;
}): ScopeRef | undefined {
	switch (row.scope_type) {
		case 'platform':
			return { type: 'platform' };
		case 'org':
			return { type: 'org' };
		case 'project':
			return row.scope_id ? { type: 'project', id: row.scope_id } : undefined;
		case 'environment':
			return row.scope_id
				? { type: 'environment', id: row.scope_id, projectId: row.scope_parent_id ?? '' }
				: undefined;
		default:
			return row.scope_id
				? ({
						type: row.scope_type,
						id: row.scope_id,
						projectId: row.scope_parent_id ?? undefined,
					} as ScopeRef)
				: undefined;
	}
}

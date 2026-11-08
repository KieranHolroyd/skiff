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
	roles,
	type Binding,
	type CompiledGrants,
	type Condition,
	type Decision,
	type Guardrail,
	type Permission,
	type Principal,
	type ResourceRef,
	type Role,
	type ScopeRef,
} from '@skiff/contracts';
import type { CoreContext } from '../context.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { newId } from '../util.ts';

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
		if (principal.kind === 'system') return compileGrants({ orgId: principal.orgId, bindings: [] });
		this.ensureMemberBinding(principal);
		const version = this.version(principal.orgId);
		const type = bindingType(principal);
		// A scoped key or an MCP consent can only narrow its user's bindings (IAM.md §2).
		const restriction =
			principal.kind === 'apiKey' || principal.kind === 'mcp'
				? { permissions: [...principal.permissions] as Permission[] }
				: undefined;
		const capped = restriction
			? `:${[...principal.permissions].sort().join(',')}`
			: '';
		const key = `${type}:${principal.userId}:${principal.orgId}:${version}${capped}`;
		const cached = this.#cache.get(key);
		if (cached) return cached;

		const rows = this.#sqlite
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
			.all(principal.orgId, type, principal.userId, principal.userId);

		const bindings = this.bindingsFromRows(principal.orgId, rows);

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
			.query('SELECT 1 FROM iam_bindings WHERE org_id = ? AND principal_type = ? AND principal_id = ? LIMIT 1')
			.get(orgId, 'user', userId);
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
		if (!role || !(role in roles)) return false;
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
};

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

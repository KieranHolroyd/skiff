/**
 * Platform IAM (IAM.md I24, §10; D129).
 *
 * Bindings at `{ type: 'platform' }` live in the same `iam_bindings` table as org bindings, but with
 * `org_id IS NULL` and `scope_type = 'platform'`. They are loaded and evaluated here rather than in
 * `IamService`, for two reasons:
 *
 *  - `IamService.bind` resolves a role inside the caller's org, and `compiledFor` looks up a role
 *    with the principal's `org_id`; platform admin roles have neither. Writing rows directly keeps
 *    `iam/service.ts` unchanged and makes the separation explicit.
 *  - The decision is the same pure engine (`compileGrants` + `authorize`): a platform binding can
 *    only grant `platform:*`, never an org permission, and a condition is evaluated exactly like an
 *    org binding's.
 *
 * `sync` (or `ensureForUser`) turns the Better Auth `user.role = admin` flag into a
 * `platform-admin` binding, carrying D129's `credentialIn: [session]` condition. There is no boot
 * migration: `createCore` calls `syncAll()` once (best effort), and any surface may call
 * `sync(userId)` on demand.
 */
import type { Database } from 'bun:sqlite';
import {
	authorize,
	compileGrants,
	canAdministerPlatform,
	canMaintainPlatform,
	canViewPlatform,
	defaultPlatformCondition,
	isPlatformRole,
	platformRoleDescriptions,
	platformRoles,
	type Binding,
	type Condition,
	type CredentialKind,
	type Permission,
	type PlatformPermission,
	type PlatformRole,
	type Principal,
	type ScopeRef,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { ForbiddenError, ConflictError, NotFoundError, ValidationError } from './errors.ts';
import type {
	GuardrailCreate,
	GuardrailUpdate,
	GuardrailView,
	PrincipalSelector,
} from './iam/governance.ts';
import { newId } from './util.ts';

const SYNC_ACTOR = 'system:platform-sync';
const PLATFORM_SCOPE: Extract<ScopeRef, { type: 'platform' }> = { type: 'platform' };

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

export interface PlatformBindingView {
	id: string;
	principalType: 'user' | 'group' | 'serviceAccount';
	principalId: string;
	roleId: PlatformRole;
	roleName: string;
	roleDescription: string;
	scope: Extract<ScopeRef, { type: 'platform' }>;
	condition: Condition | null;
	expiresAt: number | null;
	reason: string | null;
	createdBy: string;
	createdAt: number;
}

export interface PlatformSyncResult {
	/** True when the Better Auth user currently has `admin` in `user.role`. */
	admin: boolean;
	/** True when a row was written or removed. */
	changed: boolean;
}

interface GuardrailRow {
	id: string;
	org_id: string | null;
	name: string;
	principal_selector_json: string;
	permissions_json: string;
	scope_type: string | null;
	scope_id: string | null;
	condition_json: string | null;
	enabled: number;
	created_by: string;
	created_at: number;
	updated_at: number;
}

export class PlatformIamService {
	readonly #sqlite: Database;

	constructor(private readonly ctx: CoreContext) {
		this.#sqlite = ctx.sqlite;
	}

	// ------------------------------------------------------------------ sync

	/**
	 * Seed or remove the `platform-admin` binding for one Better Auth user. Admin gains the binding
	 * (session-only by default); losing the flag removes only the binding this method wrote, so a
	 * manually granted platform admin role survives.
	 */
	ensureForUser(userId: string): PlatformSyncResult {
		return this.sync(userId);
	}

	sync(userId: string): PlatformSyncResult {
		const admin = this.betterAuthAdmin(userId);
		if (admin === undefined) return { admin: false, changed: false };

		const existing = this.#sqlite
			.query<BindingRow, [string, string]>(
				`SELECT * FROM iam_bindings
				 WHERE org_id IS NULL AND scope_type = 'platform'
				   AND principal_type = 'user' AND principal_id = ?
				   AND role_id = 'platform-admin' AND created_by = ?
				 LIMIT 1`,
			)
			.get(userId, SYNC_ACTOR);

		if (admin && !existing) {
			this.#sqlite.run(
				`INSERT INTO iam_bindings
				   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, scope_parent_id,
				    condition_json, expires_at, reason, created_by, created_at)
				 VALUES (?, NULL, 'user', ?, 'platform-admin', 'platform', NULL, NULL, ?, NULL, ?, ?, ?)`,
				[
					newId('bind_'),
					userId,
					JSON.stringify(defaultPlatformCondition('platform-admin')),
					'Better Auth admin flag',
					SYNC_ACTOR,
					this.ctx.now(),
				],
			);
			return { admin: true, changed: true };
		}

		if (!admin && existing) {
			this.#sqlite.run(
				`DELETE FROM iam_bindings
				 WHERE org_id IS NULL AND scope_type = 'platform'
				   AND principal_type = 'user' AND principal_id = ?
				   AND role_id = 'platform-admin' AND created_by = ?`,
				[userId, SYNC_ACTOR],
			);
			return { admin: false, changed: true };
		}

		return { admin, changed: false };
	}

	/** Sync every Better Auth user. Called once by `createCore` at startup, and available on demand. */
	syncAll(): { users: number; changed: number } {
		try {
			const rows = this.#sqlite.query<{ id: string }, []>('SELECT id FROM user').all();
			let changed = 0;
			for (const row of rows) if (this.sync(row.id).changed) changed += 1;
			return { users: rows.length, changed };
		} catch {
			// A bare core test, or boot before Better Auth has created its tables.
			return { users: 0, changed: 0 };
		}
	}

	// ------------------------------------------------------------------ reads

	/**
	 * Every platform binding. This is a fleet-wide view, so it needs at least a platform read; only
	 * `bind`/`unbind` require a platform administrator.
	 */
	list(principal: Principal): PlatformBindingView[] {
		if (!this.canView(principal)) throw new ForbiddenError('platform:read');
		return this.platformBindings();
	}

	/** The raw rows, for a caller that already authorised (and for `whoCan`-style views). */
	platformBindings(): PlatformBindingView[] {
		return this.#sqlite
			.query<BindingRow, []>(
				`SELECT * FROM iam_bindings
				 WHERE org_id IS NULL AND scope_type = 'platform'
				 ORDER BY created_at DESC`,
			)
			.all()
			.flatMap((row) => {
				const view = this.view(row);
				return view ? [view] : [];
			});
	}

	// ------------------------------------------------------------------ writes

	/**
	 * Bind a user or group to a platform role. Only a platform admin (D129: the admin's own session
	 * once seeded) may write. Exactly one of `userId` or `groupId` is required: a group binding
	 * applies to every member of that group through `bindingsFor`'s membership join. `condition:
	 * null` explicitly removes the default session-only condition; omitting it keeps the role's
	 * default (D129's quota exception is a `platform-admin` binding with `condition: null`).
	 */
	bind(
		principal: Principal,
		input: {
			userId?: string;
			groupId?: string;
			roleId: PlatformRole | string;
			condition?: Condition | null;
			expiresAt?: number | null;
			reason?: string;
		},
	): PlatformBindingView {
		if (!this.canAdminister(principal)) throw new ForbiddenError('platform:admin');
		const userId = input.userId?.trim() ?? '';
		const groupId = input.groupId?.trim() ?? '';
		if (Boolean(userId) === Boolean(groupId))
			throw new ValidationError(
				'A platform binding needs exactly one user id or group id.',
			);
		const principalType = groupId ? ('group' as const) : ('user' as const);
		const principalId = groupId || userId;
		if (groupId && !this.#groupExists(groupId))
			throw new ValidationError(`There is no group with the id "${groupId}".`);
		if (!isPlatformRole(input.roleId))
			throw new ValidationError(`"${input.roleId}" is not a platform admin role.`);
		if (input.expiresAt != null && input.expiresAt <= this.ctx.now())
			throw new ValidationError('An expiry must be in the future.');

		const roleId = input.roleId;
		const condition =
			input.condition === undefined ? defaultPlatformCondition(roleId) : input.condition;
		const now = this.ctx.now();

		const existing = this.#sqlite
			.query<BindingRow, [string, string, string]>(
				`SELECT * FROM iam_bindings
				 WHERE org_id IS NULL AND scope_type = 'platform'
				   AND principal_type = ? AND principal_id = ? AND role_id = ?
				 LIMIT 1`,
			)
			.get(principalType, principalId, roleId);
		if (existing) {
			// Keep the write idempotent: a repeated bind returns the row rather than duplicating it.
			// An explicit condition (including `null`) updates the row, which is how D129's quota
			// exception replaces the seeded session-only condition.
			if (input.condition === undefined) {
				const view = this.view(existing);
				if (!view) throw new ValidationError(`Unknown platform admin role "${roleId}".`);
				return view;
			}
			const conditionJson = condition ? JSON.stringify(condition) : null;
			this.#sqlite.run('UPDATE iam_bindings SET condition_json = ? WHERE id = ?', [
				conditionJson,
				existing.id,
			]);
			const view = this.view({ ...existing, condition_json: conditionJson });
			if (!view) throw new ValidationError(`Unknown platform admin role "${roleId}".`);
			return view;
		}

		const id = newId('bind_');
		this.#sqlite.run(
			`INSERT INTO iam_bindings
			   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, scope_parent_id,
			    condition_json, expires_at, reason, created_by, created_at)
			 VALUES (?, NULL, ?, ?, ?, 'platform', NULL, NULL, ?, ?, ?, ?, ?)`,
			[
				id,
				principalType,
				principalId,
				roleId,
				condition ? JSON.stringify(condition) : null,
				input.expiresAt ?? null,
				input.reason ?? null,
				principal.userId,
				now,
			],
		);
		this.ctx.audit.record({
			principal,
			action: 'iam.binding.create',
			resource: 'iam_binding',
			resourceId: id,
			args: {
				principalType,
				principalId,
				roleId,
				scope: PLATFORM_SCOPE,
				condition: condition ?? null,
			},
			result: 'ok',
		});
		return {
			id,
			principalType,
			principalId,
			roleId,
			roleName: roleId,
			roleDescription: platformRoleDescriptions[roleId],
			scope: PLATFORM_SCOPE,
			condition: condition ?? null,
			expiresAt: input.expiresAt ?? null,
			reason: input.reason ?? null,
			createdBy: principal.userId,
			createdAt: now,
		};
	}

	/** Remove a platform binding. A platform admin's session is required, as for `bind`. */
	unbind(principal: Principal, bindingId: string): void {
		if (!this.canAdminister(principal)) throw new ForbiddenError('platform:admin');
		const row = this.#sqlite
			.query<BindingRow, [string]>(
				`SELECT * FROM iam_bindings
				 WHERE id = ? AND org_id IS NULL AND scope_type = 'platform'`,
			)
			.get(bindingId);
		if (!row) throw new NotFoundError('Platform binding');
		this.#sqlite.run(
			"DELETE FROM iam_bindings WHERE id = ? AND org_id IS NULL AND scope_type = 'platform'",
			[bindingId],
		);
		this.ctx.audit.record({
			principal,
			action: 'iam.binding.delete',
			resource: 'iam_binding',
			resourceId: bindingId,
			result: 'ok',
		});
	}

	// ------------------------------------------------------------------ guardrails

	/**
	 * Fleet-wide deny guardrails: `iam_guardrails` rows with `org_id IS NULL`. The engine already
	 * loads those for every org (`IamService.guardrails`), so a row written here is a platform
	 * guardrail that beats every org allow (IAM.md I11, §10).
	 */
	listGuardrails(principal: Principal): GuardrailView[] {
		if (!this.canView(principal)) throw new ForbiddenError('platform:read');
		return this.#sqlite
			.query<GuardrailRow, []>(
				`SELECT * FROM iam_guardrails WHERE org_id IS NULL ORDER BY name COLLATE NOCASE`,
			)
			.all()
			.map(guardrailView);
	}

	/**
	 * Only a platform admin who also holds `iam:manage-guardrails` in their own org may write a
	 * fleet-wide rule: it applies to every tenant, so the org-level permission is the second key.
	 */
	createGuardrail(principal: Principal, input: GuardrailCreate): GuardrailView {
		this.requireGuardrailAdmin(principal);
		const name = guardrailName(input.name);
		if (this.#guardrailNameTaken(name))
			throw new ConflictError(`A platform guardrail named "${name}" already exists.`);
		const permissions = guardrailPermissions(input.permissions);
		const selector = guardrailSelector(input.selector);
		const scope = guardrailScope(input.scope);
		const condition = input.condition ? JSON.stringify(input.condition) : null;
		const now = this.ctx.now();
		const id = newId('grd_');
		this.#sqlite.transaction(() => {
			this.#sqlite.run(
				`INSERT INTO iam_guardrails
				   (id, org_id, name, principal_selector_json, permissions_json, scope_type, scope_id,
				    condition_json, enabled, created_by, created_at, updated_at)
				 VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					name,
					JSON.stringify(selector),
					JSON.stringify(permissions),
					scope.type,
					scope.id,
					condition,
					input.enabled === false ? 0 : 1,
					principal.userId,
					now,
					now,
				],
			);
			this.#touchAllOrgs(principal.orgId);
		})();
		this.ctx.audit.record({
			principal,
			action: 'iam.guardrail.create',
			resource: 'iam_guardrail',
			resourceId: id,
			args: { scope: PLATFORM_SCOPE, name, permissions, selector, enabled: input.enabled !== false },
			result: 'ok',
		});
		return guardrailView(this.#guardrailRow(id));
	}

	updateGuardrail(principal: Principal, id: string, input: GuardrailUpdate): GuardrailView {
		this.requireGuardrailAdmin(principal);
		this.#guardrailRow(id);
		const sets: string[] = [];
		const values: Array<string | number | null> = [];
		const set = (column: string, value: string | number | null) => {
			sets.push(`${column} = ?`);
			values.push(value);
		};
		if (input.name !== undefined) {
			const name = guardrailName(input.name);
			if (this.#guardrailNameTaken(name, id))
				throw new ConflictError(`A platform guardrail named "${name}" already exists.`);
			set('name', name);
		}
		if (input.permissions !== undefined)
			set('permissions_json', JSON.stringify(guardrailPermissions(input.permissions)));
		if (input.selector !== undefined)
			set('principal_selector_json', JSON.stringify(guardrailSelector(input.selector)));
		if (input.scope !== undefined) {
			const scope = guardrailScope(input.scope);
			set('scope_type', scope.type);
			set('scope_id', scope.id);
		}
		if (input.condition !== undefined)
			set('condition_json', input.condition ? JSON.stringify(input.condition) : null);
		if (input.enabled !== undefined) set('enabled', input.enabled ? 1 : 0);
		if (sets.length === 0) return guardrailView(this.#guardrailRow(id));
		set('updated_at', this.ctx.now());
		this.#sqlite.transaction(() => {
			this.#sqlite.run(`UPDATE iam_guardrails SET ${sets.join(', ')} WHERE id = ? AND org_id IS NULL`, [
				...values,
				id,
			]);
			this.#touchAllOrgs(principal.orgId);
		})();
		this.ctx.audit.record({
			principal,
			action: 'iam.guardrail.update',
			resource: 'iam_guardrail',
			resourceId: id,
			args: { scope: PLATFORM_SCOPE, changed: sets.map((entry) => entry.split(' = ')[0]) },
			result: 'ok',
		});
		return guardrailView(this.#guardrailRow(id));
	}

	deleteGuardrail(principal: Principal, id: string): void {
		this.requireGuardrailAdmin(principal);
		const row = this.#guardrailRow(id);
		this.#sqlite.transaction(() => {
			this.#sqlite.run('DELETE FROM iam_guardrails WHERE id = ? AND org_id IS NULL', [id]);
			this.#touchAllOrgs(principal.orgId);
		})();
		this.ctx.audit.record({
			principal,
			action: 'iam.guardrail.delete',
			resource: 'iam_guardrail',
			resourceId: id,
			args: { scope: PLATFORM_SCOPE, name: row.name },
			result: 'ok',
		});
	}

	private requireGuardrailAdmin(principal: Principal): void {
		if (!this.canAdminister(principal)) throw new ForbiddenError('platform:admin');
		if (!this.ctx.iam.can(principal, 'iam:manage-guardrails', { type: 'org' }))
			throw new ForbiddenError('iam:manage-guardrails');
	}

	#guardrailNameTaken(name: string, excludeId = ''): boolean {
		const row = this.#sqlite
			.query<{ id: string }, [string, string]>(
				'SELECT id FROM iam_guardrails WHERE org_id IS NULL AND name = ? AND id != ? LIMIT 1',
			)
			.get(name, excludeId);
		return row !== null && row !== undefined;
	}

	#guardrailRow(id: string): GuardrailRow {
		const row = this.#sqlite
			.query<GuardrailRow, [string]>('SELECT * FROM iam_guardrails WHERE id = ? AND org_id IS NULL')
			.get(id);
		if (!row) throw new NotFoundError('Platform guardrail');
		return row;
	}

	/** A platform row changes every org's compiled grants, so bump every known org's version. */
	#touchAllOrgs(actingOrgId: string): void {
		const ids = new Set<string>([actingOrgId]);
		try {
			for (const row of this.#sqlite.query<{ id: string }, []>('SELECT id FROM organization').all())
				ids.add(row.id);
		} catch {
			// A bare core test before Better Auth's organization table exists.
		}
		try {
			for (const row of this.#sqlite
				.query<{ org_id: string }, []>('SELECT DISTINCT org_id FROM iam_state')
				.all())
				ids.add(row.org_id);
		} catch {
			// No IAM state yet.
		}
		for (const orgId of ids) this.ctx.iam.touch(orgId);
	}

	// ------------------------------------------------------------------ decisions

	/**
	 * Evaluate one platform permission through the engine. The condition on the binding is
	 * evaluated with the principal's credential, so a seeded `platform-admin` binding denies an API
	 * key or MCP token (D129).
	 */
	can(principal: Principal, permission: PlatformPermission | string): boolean {
		const bindings = this.bindingsFor(principal);
		if (bindings.length === 0) return false;
		const decision = authorize(
			compileGrants({ orgId: principal.orgId, bindings }),
			{
				permission: permission as Permission,
				resource: { type: 'platform' },
				context: { now: this.ctx.now(), credential: credentialOf(principal) },
			},
		);
		return decision.allow;
	}

	/**
	 * One platform permission: the engine first, then the pre-I8 rule while bindings are not seeded.
	 *
	 * The fallback is off as soon as the caller has a `platform-admin` binding, so D129's
	 * session-only condition cannot be bypassed by the Better Auth flag. Reads map to
	 * `canViewPlatform` (any credential), writes to `canAdministerPlatform` (own session only) and
	 * fleet maintenance to `canMaintainPlatform` (the prune's documented API-key exception).
	 */
	allows(principal: Principal, permission: PlatformPermission | string): boolean {
		if (this.can(principal, permission)) return true;
		if (this.hasAdminBinding(principal)) return false;
		if (permission === 'platform:read') return canViewPlatform(principal);
		if (permission === 'platform:maintenance') return canMaintainPlatform(principal);
		return canAdministerPlatform(principal);
	}

	/**
	 * The old `canViewPlatform`: engine first, with the Better Auth flag as the fallback until the
	 * admin's binding has been seeded.
	 */
	canView(principal: Principal): boolean {
		return this.allows(principal, 'platform:read');
	}

	/** The old `canAdministerPlatform`: engine first, then the flag while seeding is incomplete. */
	canAdminister(principal: Principal): boolean {
		return this.allows(principal, 'platform:settings');
	}

	/**
	 * Platform-scope maintenance (a fleet-wide prune): the `platform:maintenance` binding, or the
	 * pre-I8 rule (a platform admin's session or API key) until the binding is seeded.
	 */
	canMaintain(principal: Principal): boolean {
		return this.allows(principal, 'platform:maintenance');
	}

	// ------------------------------------------------------------------ internals

	private bindingsFor(principal: Principal): Binding[] {
		const type = bindingType(principal);
		const rows = this.#sqlite
			.query<BindingRow, [string, string, string]>(
				`SELECT * FROM iam_bindings
				 WHERE org_id IS NULL AND scope_type = 'platform'
				   AND (
				     (principal_type = ? AND principal_id = ?)
				     OR (principal_type = 'group' AND principal_id IN (
				       SELECT group_id FROM iam_group_members WHERE user_id = ?
				     ))
				   )`,
			)
			.all(type, principal.userId, principal.userId);
		return rows.flatMap((row) => {
			const permissions = rolePermissions(row.role_id);
			if (!permissions) return [];
			return [
				{
					id: row.id,
					roleId: row.role_id,
					permissions: permissions as readonly Permission[],
					scope: PLATFORM_SCOPE,
					expiresAt: row.expires_at,
					condition: parseCondition(row.condition_json),
				} satisfies Binding,
			];
		});
	}

	/** Whether a group row exists. A platform binding may name a group from any organisation. */
	#groupExists(groupId: string): boolean {
		try {
			const row = this.#sqlite
				.query<{ id: string }, [string]>('SELECT id FROM iam_groups WHERE id = ? LIMIT 1')
				.get(groupId);
			return row !== null && row !== undefined;
		} catch {
			// A bare core test before the IAM tables exist has no groups to bind.
			return false;
		}
	}

	private hasAdminBinding(principal: Principal): boolean {
		const type = bindingType(principal);
		const row = this.#sqlite
			.query<{ id: string }, [string, string, string]>(
				`SELECT id FROM iam_bindings
				 WHERE org_id IS NULL AND scope_type = 'platform' AND role_id = 'platform-admin'
				   AND (
				     (principal_type = ? AND principal_id = ?)
				     OR (principal_type = 'group' AND principal_id IN (
				       SELECT group_id FROM iam_group_members WHERE user_id = ?
				     ))
				   )
				 LIMIT 1`,
			)
			.get(type, principal.userId, principal.userId);
		return row !== null && row !== undefined;
	}

	private view(row: BindingRow): PlatformBindingView | undefined {
		if (!isPlatformRole(row.role_id)) return undefined;
		return {
			id: row.id,
			principalType: row.principal_type as PlatformBindingView['principalType'],
			principalId: row.principal_id,
			roleId: row.role_id,
			roleName: row.role_id,
			roleDescription: platformRoleDescriptions[row.role_id],
			scope: PLATFORM_SCOPE,
			condition: parseCondition(row.condition_json),
			expiresAt: row.expires_at,
			reason: row.reason,
			createdBy: row.created_by,
			createdAt: row.created_at,
		};
	}

	/** The Better Auth admin flag, or `undefined` when its table is absent. */
	private betterAuthAdmin(userId: string): boolean | undefined {
		let row: { role: string | null } | undefined;
		try {
			row = this.#sqlite
				.query<{ role: string | null }, [string]>('SELECT role FROM user WHERE id = ?')
				.get(userId) ?? undefined;
		} catch {
			return undefined;
		}
		if (!row) return false;
		return (row.role ?? '').split(',').some((role) => role.trim() === 'admin');
	}
}

/** Platform bindings may only grant platform permissions, never an org resource. */
function rolePermissions(roleId: string): readonly string[] | undefined {
	if (!isPlatformRole(roleId)) return undefined;
	return platformRoles[roleId];
}

function bindingType(principal: Principal): 'user' | 'group' | 'serviceAccount' {
	const userKinds: ReadonlySet<Principal['kind']> = new Set(['user', 'apiKey', 'mcp', 'system']);
	return userKinds.has(principal.kind) ? 'user' : 'serviceAccount';
}

/** A `user` principal only ever comes from a dashboard session; keys are `apiKey` and MCP is `mcp`. */
function credentialOf(principal: Principal): CredentialKind | undefined {
	const sessionKinds: ReadonlySet<Principal['kind']> = new Set(['user']);
	return principal.credential ?? (sessionKinds.has(principal.kind) ? 'session' : undefined);
}

function parseCondition(json: string | null): Condition | null {
	if (!json) return null;
	try {
		const value: unknown = JSON.parse(json);
		if (!value || typeof value !== 'object' || typeof (value as { op?: unknown }).op !== 'string')
			return null;
		return value as Condition;
	} catch {
		// Malformed JSON on a binding must deny, not allow.
		return { op: '__invalid' } as unknown as Condition;
	}
}

function guardrailName(value: string | undefined): string {
	const name = (value ?? '').trim();
	if (name.length < 2 || name.length > 80)
		throw new ValidationError('A platform guardrail needs a name between 2 and 80 characters.');
	return name;
}

function guardrailPermissions(value: readonly string[] | undefined): string[] {
	if (!value || value.length === 0)
		throw new ValidationError('A platform guardrail needs at least one permission.');
	if (value.length > 500) throw new ValidationError('A platform guardrail may deny at most 500 permissions.');
	return value.map((permission) => {
		const trimmed = String(permission).trim();
		if (!trimmed || trimmed.length > 120)
			throw new ValidationError('Every guardrail permission must be a permission name of 1–120 characters.');
		return trimmed;
	});
}

function guardrailSelector(value: PrincipalSelector | undefined): PrincipalSelector {
	const source = value ?? {};
	const list = (items: readonly string[] | undefined): string[] | undefined =>
		items === undefined
			? undefined
			: items.map((item) => {
					const trimmed = String(item).trim();
					if (!trimmed) throw new ValidationError('A guardrail selector value cannot be empty.');
					return trimmed;
				});
	return {
		...(source.principalTypes ? { principalTypes: list(source.principalTypes)! } : {}),
		...(source.principalIds ? { principalIds: list(source.principalIds)! } : {}),
		...(source.groupIds ? { groupIds: list(source.groupIds)! } : {}),
	};
}

/**
 * `null` means fleet-wide: the engine treats a row without a scope as covering every resource.
 * An environment scope is refused: the engine needs a parent project id, which this small surface
 * does not collect.
 */
function guardrailScope(scope: ScopeRef | undefined): { type: string | null; id: string | null } {
	if (!scope) return { type: null, id: null };
	if (scope.type === 'platform' || scope.type === 'org') return { type: scope.type, id: null };
	if (scope.type === 'project') return { type: 'project', id: scope.id };
	throw new ValidationError(
		'A platform guardrail applies fleet-wide, to the platform, an org or a project.',
	);
}

function guardrailView(row: GuardrailRow): GuardrailView {
	return {
		id: row.id,
		orgId: row.org_id,
		name: row.name,
		selector: parseSelector(row.principal_selector_json),
		permissions: parseStrings(row.permissions_json),
		scope: parseScope(row),
		condition: parseCondition(row.condition_json),
		enabled: row.enabled !== 0,
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function parseSelector(json: string): PrincipalSelector {
	try {
		const value: unknown = JSON.parse(json);
		if (!value || typeof value !== 'object') return {};
		const source = value as Record<string, unknown>;
		const list = (items: unknown): string[] | undefined =>
			Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : undefined;
		return {
			...(list(source.principalTypes) ? { principalTypes: list(source.principalTypes) } : {}),
			...(list(source.principalIds) ? { principalIds: list(source.principalIds) } : {}),
			...(list(source.groupIds) ? { groupIds: list(source.groupIds) } : {}),
		};
	} catch {
		return {};
	}
}

function parseStrings(json: string): string[] {
	try {
		const value: unknown = JSON.parse(json);
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
	} catch {
		return [];
	}
}

function parseScope(row: GuardrailRow): ScopeRef | null {
	if (!row.scope_type) return null;
	if (row.scope_type === 'platform' || row.scope_type === 'org') return { type: row.scope_type };
	if (!row.scope_id) return null;
	return { type: row.scope_type, id: row.scope_id } as ScopeRef;
}

/**
 * Platform IAM (IAM.md I24, §10; D129).
 *
 * Bindings at `{ type: 'platform' }` live in the same `iam_bindings` table as org bindings, but with
 * `org_id IS NULL` and `scope_type = 'platform'`. They are loaded and evaluated here rather than in
 * `IamService`, for two reasons:
 *
 *  - `IamService.bind` resolves a role inside the caller's org, and `compiledFor` looks up a role
 *    with the principal's `org_id`; platform roles have neither. Writing rows directly keeps
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
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ForbiddenError, NotFoundError, ValidationError } from './errors.ts';
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

export class PlatformIamService {
	readonly #sqlite: Database;

	constructor(private readonly ctx: CoreContext) {
		this.#sqlite = ctx.sqlite;
	}

	// ------------------------------------------------------------------ sync

	/**
	 * Seed or remove the `platform-admin` binding for one Better Auth user. Admin gains the binding
	 * (session-only by default); losing the flag removes only the binding this method wrote, so a
	 * manually granted platform role survives.
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
	 * Bind a user to a platform role. Only a platform admin (D129: the admin's own session once
	 * seeded) may write. `condition: null` explicitly removes the default session-only condition;
	 * omitting it keeps the role's default (D129's quota exception is a `platform-admin` binding with
	 * `condition: null`).
	 */
	bind(
		principal: Principal,
		input: {
			userId: string;
			roleId: PlatformRole | string;
			condition?: Condition | null;
			expiresAt?: number | null;
			reason?: string;
		},
	): PlatformBindingView {
		if (!this.canAdminister(principal)) throw new ForbiddenError('platform:admin');
		if (!input.userId.trim()) throw new ValidationError('A platform binding needs a user id.');
		if (!isPlatformRole(input.roleId))
			throw new ValidationError(`"${input.roleId}" is not a platform role.`);
		if (input.expiresAt != null && input.expiresAt <= this.ctx.now())
			throw new ValidationError('An expiry must be in the future.');

		const roleId = input.roleId;
		const condition =
			input.condition === undefined ? defaultPlatformCondition(roleId) : input.condition;
		const now = this.ctx.now();

		const existing = this.#sqlite
			.query<BindingRow, [string, string]>(
				`SELECT * FROM iam_bindings
				 WHERE org_id IS NULL AND scope_type = 'platform'
				   AND principal_type = 'user' AND principal_id = ? AND role_id = ?
				 LIMIT 1`,
			)
			.get(input.userId, roleId);
		if (existing) {
			// Keep the write idempotent: a repeated bind returns the row rather than duplicating it.
			// An explicit condition (including `null`) updates the row, which is how D129's quota
			// exception replaces the seeded session-only condition.
			if (input.condition === undefined) {
				const view = this.view(existing);
				if (!view) throw new ValidationError(`Unknown platform role "${roleId}".`);
				return view;
			}
			const conditionJson = condition ? JSON.stringify(condition) : null;
			this.#sqlite.run('UPDATE iam_bindings SET condition_json = ? WHERE id = ?', [
				conditionJson,
				existing.id,
			]);
			const view = this.view({ ...existing, condition_json: conditionJson });
			if (!view) throw new ValidationError(`Unknown platform role "${roleId}".`);
			return view;
		}

		const id = newId('bind_');
		this.#sqlite.run(
			`INSERT INTO iam_bindings
			   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, scope_parent_id,
			    condition_json, expires_at, reason, created_by, created_at)
			 VALUES (?, NULL, 'user', ?, ?, 'platform', NULL, NULL, ?, ?, ?, ?, ?)`,
			[
				id,
				input.userId,
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
				principalType: 'user',
				principalId: input.userId,
				roleId,
				scope: PLATFORM_SCOPE,
				condition: condition ?? null,
			},
			result: 'ok',
		});
		return {
			id,
			principalType: 'user',
			principalId: input.userId,
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
	 * The old `canViewPlatform`: engine first, with the Better Auth flag as the fallback until the
	 * admin's binding has been seeded. Once a `platform-admin` binding exists, the fallback is off,
	 * so a session-only condition cannot be bypassed by the flag.
	 */
	canView(principal: Principal): boolean {
		if (this.can(principal, 'platform:read')) return true;
		return !this.hasAdminBinding(principal) && canViewPlatform(principal);
	}

	/** The old `canAdministerPlatform`: engine first, then the flag while seeding is incomplete. */
	canAdminister(principal: Principal): boolean {
		if (this.can(principal, 'platform:settings')) return true;
		return !this.hasAdminBinding(principal) && canAdministerPlatform(principal);
	}

	/**
	 * Platform-scope maintenance (a fleet-wide prune): the `platform:maintenance` binding, or the
	 * pre-I8 rule (a platform admin's session or API key) until the binding is seeded.
	 */
	canMaintain(principal: Principal): boolean {
		if (this.can(principal, 'platform:maintenance')) return true;
		if (this.hasAdminBinding(principal)) return false;
		return canMaintainPlatform(principal);
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

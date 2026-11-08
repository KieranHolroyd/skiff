/**
 * Service accounts (IAM.md I13, §4, §7.2): org-owned machine principals with a stable `sa_…` id.
 * They are bound like any other principal, so this module owns only the account rows. Access keys,
 * federation trusts, STS tokens and impersonation arrive in later phases (I3/I4); until then a
 * service account cannot authenticate as itself.
 *
 * Permissions are read from `principal.permissions` for now, like the rest of the IAM writes: the
 * authorization engine is not yet wired to call sites (IAM.md §13), so these methods check
 * `serviceAccount:read|create|update|delete` directly.
 */
import {
	SLUG_MAX,
	SLUG_MIN,
	SLUG_PATTERN,
	type Permission,
	type Principal,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors.ts';
import { newId } from './util.ts';

interface ServiceAccountRow {
	id: string;
	org_id: string;
	name: string;
	description: string;
	owner_group_id: string | null;
	disabled_at: number | null;
	created_by: string;
	created_at: number;
}

export interface ServiceAccountView {
	id: string;
	name: string;
	description: string;
	/** The `iam_groups.id` that owns the account, or null when the org does. */
	ownerGroupId: string | null;
	/** A disabled account keeps its keys and bindings; it just can't be used (IAM.md §7.2). */
	disabled: boolean;
	disabledAt: number | null;
	createdBy: string;
	createdAt: number;
}

export interface ServiceAccountCreate {
	name: string;
	description?: string;
	ownerGroupId?: string | null;
}

export interface ServiceAccountUpdate {
	name?: string;
	description?: string;
	ownerGroupId?: string | null;
	disabled?: boolean;
}

export class ServiceAccountService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- reads

	list(principal: Principal): ServiceAccountView[] {
		this.#require(principal, 'serviceAccount:read');
		return this.ctx.sqlite
			.query<ServiceAccountRow, [string]>(
				'SELECT * FROM service_accounts WHERE org_id = ? ORDER BY name',
			)
			.all(principal.orgId)
			.map(view);
	}

	get(principal: Principal, id: string): ServiceAccountView {
		this.#require(principal, 'serviceAccount:read');
		return view(this.#row(principal, id));
	}

	// ---------------------------------------------------------------- mutations

	create(principal: Principal, input: ServiceAccountCreate): ServiceAccountView {
		this.#require(principal, 'serviceAccount:create');
		const name = normalizeName(input.name);
		const description = (input.description ?? '').trim();
		const ownerGroupId = input.ownerGroupId ?? null;
		if (ownerGroupId) this.#requireGroup(principal.orgId, ownerGroupId);
		if (this.#nameTaken(principal.orgId, name)) this.#conflict(name);

		const id = newId('sa_');
		const now = this.ctx.now();
		this.ctx.sqlite.run(
			`INSERT INTO service_accounts
			   (id, org_id, name, description, owner_group_id, disabled_at, created_by, created_at)
			 VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
			[id, principal.orgId, name, description, ownerGroupId, principal.userId, now],
		);
		this.ctx.audit.record({
			principal,
			action: 'service_account.create',
			resource: 'service_account',
			resourceId: id,
			args: { name, description, ownerGroupId },
			result: 'ok',
		});
		return {
			id,
			name,
			description,
			ownerGroupId,
			disabled: false,
			disabledAt: null,
			createdBy: principal.userId,
			createdAt: now,
		};
	}

	update(principal: Principal, id: string, input: ServiceAccountUpdate): ServiceAccountView {
		this.#require(principal, 'serviceAccount:update');
		const row = this.#row(principal, id);
		const sets: string[] = [];
		const values: Array<string | number | null> = [];
		const changes: Record<string, { from: string | number | boolean | null; to: string | number | boolean | null }> = {};
		let grantsChanged = false;
		const set = (
			key: string,
			column: string,
			value: string | number | null,
			before: string | number | boolean | null,
			after: string | number | boolean | null,
		) => {
			sets.push(`${column} = ?`);
			values.push(value);
			changes[key] = { from: before, to: after };
		};

		if (input.name !== undefined) {
			const name = normalizeName(input.name);
			if (name !== row.name) {
				if (this.#nameTaken(principal.orgId, name, id)) this.#conflict(name);
				set('name', 'name', name, row.name, name);
			}
		}
		if (input.description !== undefined) {
			const description = input.description.trim();
			if (description !== row.description)
				set('description', 'description', description, row.description, description);
		}
		if (input.ownerGroupId !== undefined) {
			const ownerGroupId = input.ownerGroupId;
			if (ownerGroupId) this.#requireGroup(principal.orgId, ownerGroupId);
			if (ownerGroupId !== row.owner_group_id)
				set('ownerGroupId', 'owner_group_id', ownerGroupId, row.owner_group_id, ownerGroupId);
		}
		if (input.disabled !== undefined) {
			const wasDisabled = row.disabled_at !== null;
			if (input.disabled !== wasDisabled) {
				const disabledAt = input.disabled ? this.ctx.now() : null;
				set('disabledAt', 'disabled_at', disabledAt, row.disabled_at, disabledAt);
				grantsChanged = true;
			}
		}

		if (sets.length > 0) {
			this.ctx.sqlite.transaction(() => {
				this.ctx.sqlite.run(`UPDATE service_accounts SET ${sets.join(', ')} WHERE id = ?`, [
					...values,
					id,
				]);
				// A disabled account must not keep using a compiled grant from the cache (IAM.md §5.2).
				if (grantsChanged) this.ctx.iam.touch(principal.orgId);
			})();
			this.ctx.audit.record({
				principal,
				action: 'service_account.update',
				resource: 'service_account',
				resourceId: id,
				args: { changes },
				result: 'ok',
			});
		}
		return view(this.#row(principal, id));
	}

	delete(principal: Principal, id: string): void {
		this.#require(principal, 'serviceAccount:delete');
		const row = this.#row(principal, id);
		const bound = this.ctx.sqlite
			.query(
				`SELECT 1 FROM iam_bindings
				 WHERE (org_id = ? OR org_id IS NULL) AND principal_type = 'serviceAccount' AND principal_id = ?
				 LIMIT 1`,
			)
			.get(principal.orgId, id);
		if (bound)
			throw new ConflictError(
				'Unbind this service account from every role before deleting it. Disabling it is the normal off-switch.',
			);

		this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run('DELETE FROM service_accounts WHERE id = ?', [id]);
			this.ctx.iam.touch(principal.orgId);
		})();
		this.ctx.audit.record({
			principal,
			action: 'service_account.delete',
			resource: 'service_account',
			resourceId: id,
			args: { name: row.name },
			result: 'ok',
		});
	}

	// ---------------------------------------------------------------- internals

	#row(principal: Principal, id: string): ServiceAccountRow {
		const row = this.ctx.sqlite
			.query<ServiceAccountRow, [string, string]>(
				'SELECT * FROM service_accounts WHERE id = ? AND org_id = ?',
			)
			.get(id, principal.orgId);
		if (!row) throw new NotFoundError('Service account');
		return row;
	}

	#requireGroup(orgId: string, groupId: string): void {
		const group = this.ctx.sqlite
			.query('SELECT 1 FROM iam_groups WHERE id = ? AND org_id = ?')
			.get(groupId, orgId);
		if (!group)
			throw new ValidationError('The owner group must be a group in this organisation.');
	}

	#nameTaken(orgId: string, name: string, exceptId?: string): boolean {
		const row = exceptId
			? this.ctx.sqlite
					.query('SELECT 1 FROM service_accounts WHERE org_id = ? AND name = ? AND id != ?')
					.get(orgId, name, exceptId)
			: this.ctx.sqlite
					.query('SELECT 1 FROM service_accounts WHERE org_id = ? AND name = ?')
					.get(orgId, name);
		return row !== null;
	}

	#conflict(name: string): never {
		throw new ConflictError(`A service account named "${name}" already exists.`);
	}

	#require(principal: Principal, permission: Permission): void {
		if (!principal.permissions.has(permission)) throw new ForbiddenError(permission);
	}
}

function normalizeName(raw: string): string {
	const name = raw.trim().toLowerCase();
	if (name.length < SLUG_MIN || name.length > SLUG_MAX)
		throw new ValidationError(`A service account name must be ${SLUG_MIN}–${SLUG_MAX} characters.`);
	if (!SLUG_PATTERN.test(name))
		throw new ValidationError(
			'A service account name uses lowercase letters, digits and single hyphens; it starts and ends with a letter or digit.',
		);
	return name;
}

function view(row: ServiceAccountRow): ServiceAccountView {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		ownerGroupId: row.owner_group_id,
		disabled: row.disabled_at !== null,
		disabledAt: row.disabled_at,
		createdBy: row.created_by,
		createdAt: row.created_at,
	};
}

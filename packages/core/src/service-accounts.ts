/**
 * Service accounts (IAM.md I13, §4, §7.2): org-owned machine principals with a stable `sa_…` id.
 * They are bound like any other principal. This module owns the account rows and the
 * impersonation token (`impersonate`); access keys live in `access-keys.ts` and federation trusts
 * in `iam/federation.ts`. A token or key carries the account's bindings, never the caller's.
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

const DAY_MS = 86_400_000;
/** Impersonation tokens last at most one hour (IAM.md I13, §7.2). */
export const MAX_IMPERSONATION_TTL_SECONDS = 60 * 60;
const DEFAULT_IMPERSONATION_TTL_SECONDS = 60 * 60;

/** IAM.md §9.5: a service account with no use for this long is flagged (and may be disabled). */
export const SERVICE_ACCOUNT_UNUSED_DAYS = 90;

/**
 * The org policy that would turn the flag into an automatic disable has no column yet (IAM.md §9.5).
 * Until it does, the sweep only reports unused accounts; flip this constant when policy storage
 * lands. `ServiceAccountService.sweepUnused` already supports the disable path.
 */
export const SERVICE_ACCOUNT_AUTO_DISABLE_UNUSED = false;

interface ServiceAccountRow {
	id: string;
	org_id: string;
	name: string;
	description: string;
	owner_group_id: string | null;
	disabled_at: number | null;
	created_by: string;
	created_at: number;
	/** MAX(access_keys.last_used_at) for this account, or null when no key has been used. */
	last_used_at?: number | null;
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
	/** The newest `access_keys.last_used_at` for this account, or null when it has never been used. */
	lastUsedAt: number | null;
	/** Whole days since the last use, or since creation when there is no use yet. */
	unusedDays: number;
	/** `unusedDays` is at or beyond {@link SERVICE_ACCOUNT_UNUSED_DAYS} (IAM.md §9.5). */
	unused: boolean;
}

/** The daily hygiene pass: what is unused, and what was disabled when policy allowed it. */
export interface ServiceAccountSweep {
	unused: ServiceAccountView[];
	autoDisabled: ServiceAccountView[];
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

/** The result of a user minting a token for a service account (IAM.md §7.2). */
export interface ServiceAccountToken {
	accessToken: string;
	tokenType: 'Bearer';
	expiresIn: number;
	audience: string;
	serviceAccount: ServiceAccountView;
}

export interface ImpersonationOptions {
	/** Seconds; defaults to one hour and is capped at {@link MAX_IMPERSONATION_TTL_SECONDS}. */
	ttl?: number;
	/** The minted token's audience; defaults to the platform origin. */
	audience?: string;
}

const SERVICE_ACCOUNT_SELECT = `
	SELECT sa.*,
	       (SELECT MAX(ak.last_used_at) FROM access_keys ak
	         WHERE ak.org_id = sa.org_id AND ak.principal_type = 'serviceAccount'
	           AND ak.principal_id = sa.id) AS last_used_at
	  FROM service_accounts sa`;

export class ServiceAccountService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- reads

	list(principal: Principal): ServiceAccountView[] {
		this.#require(principal, 'serviceAccount:read');
		return this.#views(principal.orgId);
	}

	get(principal: Principal, id: string): ServiceAccountView {
		this.#require(principal, 'serviceAccount:read');
		return view(this.#row(principal, id), this.ctx.now());
	}

	/**
	 * Mint a short-lived STS token for one service account (`serviceAccount:impersonate`, IAM.md
	 * I13, §7.2). This is the equivalent of `skif sa token <name>`: a person debugs a CI identity
	 * without a standing key. The token names the account and carries the caller as its `act`
	 * claim; it is audited as `service_account.impersonate` against the account.
	 *
	 * The account's bindings remain the permission ceiling: the token carries no `scope`, so a
	 * surface compiles the same grants an access key would. Disabling the account stops it at once.
	 */
	async impersonate(
		principal: Principal,
		id: string,
		options: ImpersonationOptions = {},
	): Promise<ServiceAccountToken> {
		this.#require(principal, 'serviceAccount:impersonate');
		const row = this.#row(principal, id);
		if (row.disabled_at !== null)
			throw new ValidationError('A disabled service account cannot be impersonated.');

		const ttl = impersonationTtl(options.ttl);
		const audience = impersonationAudience(
			options.audience ?? this.ctx.config.platformOrigin,
		);
		const accessToken = await this.ctx.signingKeys.sign(
			'sts',
			{
				sub: row.id,
				aud: audience,
				org_id: row.org_id,
				// RFC 8693 §4.1 `act`: the person the machine identity is standing in for.
				act: { iss: this.ctx.config.platformOrigin, sub: principal.userId },
				impersonated_by: principal.userId,
			},
			ttl,
		);

		this.ctx.audit.record({
			principal,
			action: 'service_account.impersonate',
			resource: 'service_account',
			resourceId: row.id,
			orgId: row.org_id,
			args: { name: row.name, ttl, audience, actingFor: principal.userId },
			result: 'ok',
		});

		return {
			accessToken,
			tokenType: 'Bearer',
			expiresIn: ttl,
			audience,
			serviceAccount: view(row, this.ctx.now()),
		};
	}

	/** Enabled accounts with no use for `minDays` (default 90), for Settings → Service accounts. */
	unused(principal: Principal, options: { minDays?: number } = {}): ServiceAccountView[] {
		this.#require(principal, 'serviceAccount:read');
		return this.#views(principal.orgId).filter(
			(account) => !account.disabled && account.unusedDays >= (options.minDays ?? SERVICE_ACCOUNT_UNUSED_DAYS),
		);
	}

	// ---------------------------------------------------------------- maintenance

	/**
	 * The IAM daily sweep's service-account pass. `unused` is every enabled account at or beyond
	 * `minDays`; `autoDisabled` is non-empty only when the caller passes `autoDisable` (the org
	 * policy does not exist yet, so the maintenance sweep passes {@link SERVICE_ACCOUNT_AUTO_DISABLE_UNUSED}).
	 * Rows are never deleted: disabling keeps keys, bindings and history (IAM.md §7.2).
	 */
	sweepUnused(
		orgId: string,
		options: { now?: number; minDays?: number; autoDisable?: boolean } = {},
	): ServiceAccountSweep {
		const now = options.now ?? this.ctx.now();
		const minDays = options.minDays ?? SERVICE_ACCOUNT_UNUSED_DAYS;
		const candidates = this.#views(orgId, now).filter(
			(account) => !account.disabled && account.unusedDays >= minDays,
		);
		const autoDisabled: ServiceAccountView[] = [];
		if (options.autoDisable) {
			const system = maintenancePrincipal(orgId);
			for (const account of candidates) {
				this.update(system, account.id, { disabled: true });
				autoDisabled.push(account);
			}
		}
		return { unused: candidates, autoDisabled };
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
			lastUsedAt: null,
			unusedDays: 0,
			unused: false,
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
		return view(this.#row(principal, id), this.ctx.now());
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
				`${SERVICE_ACCOUNT_SELECT}
				 WHERE sa.id = ? AND sa.org_id = ?`,
			)
			.get(id, principal.orgId);
		if (!row) throw new NotFoundError('Service account');
		return row;
	}

	#views(orgId: string, now = this.ctx.now()): ServiceAccountView[] {
		return this.ctx.sqlite
			.query<ServiceAccountRow, [string]>(
				`${SERVICE_ACCOUNT_SELECT}
				 WHERE sa.org_id = ? ORDER BY sa.name`,
			)
			.all(orgId)
			.map((row) => view(row, now));
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

function impersonationTtl(value: number | undefined): number {
	if (value === undefined) return DEFAULT_IMPERSONATION_TTL_SECONDS;
	if (!Number.isInteger(value) || value <= 0)
		throw new ValidationError('A token TTL must be a positive whole number of seconds.');
	if (value > MAX_IMPERSONATION_TTL_SECONDS)
		throw new ValidationError(
			`An impersonation token lasts at most ${MAX_IMPERSONATION_TTL_SECONDS} seconds (one hour).`,
		);
	return value;
}

function impersonationAudience(value: string | undefined): string {
	const audience = value?.trim() || 'skiff';
	if (audience.length > 512 || /[\u0000-\u001f\u007f]/.test(audience))
		throw new ValidationError('A token audience must be 1–512 printable characters.');
	return audience;
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

function view(row: ServiceAccountRow, now: number): ServiceAccountView {
	const lastUsedAt = row.last_used_at ?? null;
	// A never-used account is measured from creation, so a new account is not flagged as stale.
	const since = lastUsedAt ?? row.created_at;
	const unusedDays = Math.max(0, Math.floor((now - since) / DAY_MS));
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		ownerGroupId: row.owner_group_id,
		disabled: row.disabled_at !== null,
		disabledAt: row.disabled_at,
		createdBy: row.created_by,
		createdAt: row.created_at,
		lastUsedAt,
		unusedDays,
		unused: unusedDays >= SERVICE_ACCOUNT_UNUSED_DAYS,
	};
}

/** The in-process actor for the daily hygiene pass; it may only disable an account. */
function maintenancePrincipal(orgId: string): Principal {
	return {
		kind: 'system',
		userId: 'system:iam-maintenance',
		orgId,
		role: 'viewer',
		permissions: new Set<Permission>(['serviceAccount:update']),
		credential: 'system',
	};
}

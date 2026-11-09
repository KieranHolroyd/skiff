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
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors.ts';
import { newId, sha256Hex } from './util.ts';

const DAY_MS = 86_400_000;

/**
 * The internal actor that provisions per-repository pipeline accounts (IAM.md I3, §7.2). It is not
 * reachable from a surface; its fixed, empty permission set only names the actor in audit rows.
 */
const PIPELINE_PROVISIONER = 'system:pipeline-provision';

/**
 * The three managed roles a pipeline account is bound to. They are ordinary custom roles, so an
 * owner can inspect every grant in Settings → Access. The permission sets are re-asserted whenever
 * an account is ensured, which keeps a hand-edited role from silently widening a pipeline.
 */
const PIPELINE_ROLE_NAMES = {
	repository: 'pipeline-repository',
	deploy: 'pipeline-deploy',
	image: 'pipeline-image',
} as const;

/** `pipeline:*` at one `pipelineRepository` scope. */
const PIPELINE_REPOSITORY_PERMISSIONS: readonly Permission[] = [
	'pipeline:read',
	'pipeline:dispatch',
	'pipeline:cancel',
	'pipeline:manage',
	'pipeline:approve',
];

/** Exactly what a trusted run needs to deploy a linked project. */
const PIPELINE_DEPLOY_PERMISSIONS: readonly Permission[] = ['deployment:create', 'project:update'];

/** Push only the repository's own image namespace; pull is not needed for a push. */
const PIPELINE_IMAGE_PERMISSIONS: readonly Permission[] = ['image:push'];
/** Impersonation tokens last at most one hour (IAM.md I13, §7.2). */
export const MAX_IMPERSONATION_TTL_SECONDS = 60 * 60;
const DEFAULT_IMPERSONATION_TTL_SECONDS = 60 * 60;

/** IAM.md §9.5: a service account with no use for this long is flagged (and may be disabled). */
export const SERVICE_ACCOUNT_UNUSED_DAYS = 90;

// The org policy that turns the unused-account flag into an automatic disable lives in
// `org_auth_policies.auto_disable_unused_service_accounts` (IAM.md §9.5). The daily sweep reads it
// through `AuthPolicyService`; without it the sweep only reports unused accounts.

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

/**
 * The minimum identity a repository's trusted jobs act as (IAM.md §7.2). `repositoryId` is the
 * `pipeline_repositories.id`; `createdBy` only records who caused the account to be generated.
 */
export interface PipelineAccountInput {
	orgId: string;
	repositoryId: string;
	repositoryName: string;
	createdBy: string;
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
	 * I13, §7.2). This is the equivalent of `yoal sa token <name>`: a person debugs a CI identity
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

	// ---------------------------------------------------------------- pipelines (IAM.md §7.2)

	/**
	 * The service account a repository's trusted jobs act as, created on first use. The account is
	 * `pipeline-<repo>` (shortened with a stable hash when the name would exceed the slug limit),
	 * owned by the org, and bound to the least privilege the jobs need:
	 *
	 *   - `pipeline:*` at this repository's `pipelineRepository` scope;
	 *   - `deployment:create` and `project:update` at each currently linked project;
	 *   - `image:push` at this repository's own registry repository (`<org>/<repo>`).
	 *
	 * Every call reconciles the bindings to the current links, so adding or removing a deploy target
	 * is enough; the engine also calls this before a deploy to backfill repositories created before
	 * the column existed. Only bindings this provisioner created are pruned, so a deliberate grant
	 * made in Settings → Access is left alone. Returns the `service_accounts.id`.
	 */
	ensurePipelineAccount(input: PipelineAccountInput): string {
		const { orgId, repositoryId, repositoryName } = input;
		const account = this.#ensurePipelineAccountRow(input);
		const orgSlug = this.#orgSlug(orgId);
		const repositoryRole = this.#ensureManagedRole(
			orgId,
			PIPELINE_ROLE_NAMES.repository,
			PIPELINE_REPOSITORY_PERMISSIONS,
			input.createdBy,
		);
		const deployRole = this.#ensureManagedRole(
			orgId,
			PIPELINE_ROLE_NAMES.deploy,
			PIPELINE_DEPLOY_PERMISSIONS,
			input.createdBy,
		);
		const imageRole = this.#ensureManagedRole(
			orgId,
			PIPELINE_ROLE_NAMES.image,
			PIPELINE_IMAGE_PERMISSIONS,
			input.createdBy,
		);
		const projectIds = new Set(this.#linkedProjectIds(repositoryId));
		const imageRepository = orgSlug ? `${orgSlug}/${repositoryName}` : null;

		this.#ensureBinding(orgId, account.id, repositoryRole.id, 'pipelineRepository', repositoryId);
		if (imageRepository)
			this.#ensureBinding(orgId, account.id, imageRole.id, 'repository', imageRepository);
		for (const projectId of projectIds)
			this.#ensureBinding(orgId, account.id, deployRole.id, 'project', projectId);
		this.#pruneManagedBindings(orgId, account.id, {
			repositoryId,
			imageRepository,
			projectIds,
			roles: {
				repository: repositoryRole.id,
				deploy: deployRole.id,
				image: imageRole.id,
			},
		});

		// A corrected managed role changes every account using it, so clear the org cache. Ordinary
		// provisioning only changes this account's own bindings; forget just its cached grants.
		if (repositoryRole.changed || deployRole.changed || imageRole.changed) this.ctx.iam.touch(orgId);
		else this.ctx.iam.forget(orgId, 'serviceAccount', account.id);

		if (account.created) {
			this.ctx.audit.record({
				principal: pipelineProvisioner(orgId),
				action: 'service_account.create',
				resource: 'service_account',
				resourceId: account.id,
				args: {
					name: account.name,
					repositoryId,
					repositoryName,
					reason: 'per-repository pipeline account (IAM.md §7.2)',
				},
				result: 'ok',
			});
		}
		return account.id;
	}

	/**
	 * Whether a pipeline account may still act. The engine checks this before a deploy so that
	 * disabling the account in Settings → Access is a real off-switch for the repository.
	 */
	pipelineAccountEnabled(orgId: string, serviceAccountId: string): boolean {
		const row = this.ctx.sqlite
			.query<{ disabled_at: number | null }, [string, string]>(
				'SELECT disabled_at FROM service_accounts WHERE id = ? AND org_id = ?',
			)
			.get(serviceAccountId, orgId);
		return row?.disabled_at === null;
	}

	/**
	 * Remove the bindings this provisioner made for one account. Called when a repository is
	 * deleted; the account itself stays (disabled-like history without keys) so recreating the
	 * repository with the same name can reuse it.
	 */
	removePipelineAccountBindings(orgId: string, serviceAccountId: string): number {		const result = this.ctx.sqlite.run(
			`DELETE FROM iam_bindings
			  WHERE org_id = ? AND principal_type = 'serviceAccount' AND principal_id = ?
			    AND created_by = ?
			    AND role_id IN (
			      SELECT id FROM iam_roles WHERE org_id = ? AND name IN (?, ?, ?)
			    )`,
			[
				orgId,
				serviceAccountId,
				PIPELINE_PROVISIONER,
				orgId,
				PIPELINE_ROLE_NAMES.repository,
				PIPELINE_ROLE_NAMES.deploy,
				PIPELINE_ROLE_NAMES.image,
			],
		);
		if (result.changes > 0) this.ctx.iam.forget(orgId, 'serviceAccount', serviceAccountId);
		return result.changes;
	}

	// ---------------------------------------------------------------- maintenance

	/**
	 * The IAM daily sweep's service-account pass. `unused` is every enabled account at or beyond
	 * `minDays`; `autoDisabled` is non-empty only when the caller passes `autoDisable`, which the
	 * maintenance sweep reads from the org auth policy (default off).
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

	/**
	 * Find or create the account row and link it to the repository. A name collision with another
	 * repository's account (two repository names that slugify the same) gets a stable hashed
	 * suffix rather than sharing an identity.
	 */
	#ensurePipelineAccountRow(input: PipelineAccountInput): { id: string; name: string; created: boolean } {
		const { orgId, repositoryId, repositoryName, createdBy } = input;
		const row = this.ctx.sqlite
			.query<{ service_account_id: string | null }, [string, string]>(
				'SELECT service_account_id FROM pipeline_repositories WHERE id = ? AND org_id = ?',
			)
			.get(repositoryId, orgId);
		const linked = row?.service_account_id ?? null;
		if (linked) {
			const account = this.ctx.sqlite
				.query<{ name: string }, [string, string]>('SELECT name FROM service_accounts WHERE id = ? AND org_id = ?')
				.get(linked, orgId);
			if (account) return { id: linked, name: account.name, created: false };
		}

		for (let attempt = 0; attempt < 20; attempt++) {
			const name = pipelineAccountName(repositoryName, attempt);
			const existing = this.ctx.sqlite
				.query<{ id: string; description: string }, [string, string]>(
					'SELECT id, description FROM service_accounts WHERE org_id = ? AND name = ?',
				)
				.get(orgId, name);
			if (existing) {
				const other = this.ctx.sqlite
					.query<{ id: string }, [string, string]>(
						'SELECT id FROM pipeline_repositories WHERE service_account_id = ? AND id != ?',
					)
					.get(existing.id, repositoryId);
				// Reuse only an account this provisioner made (or one already linked to this
				// repository). A person's own `pipeline-…` account is left alone and the generated
				// name gets its hashed suffix instead.
				const ours = existing.description.startsWith('Pipeline account for ');
				if (other || !ours) continue;
				this.ctx.sqlite.run('UPDATE pipeline_repositories SET service_account_id = ? WHERE id = ? AND org_id = ?', [
					existing.id,
					repositoryId,
					orgId,
				]);
				return { id: existing.id, name, created: false };
			}
			const id = newId('sa_');
			this.ctx.sqlite.run(
				`INSERT INTO service_accounts
				   (id, org_id, name, description, owner_group_id, disabled_at, created_by, created_at)
				 VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
				[
					id,
					orgId,
					name,
					`Pipeline account for ${repositoryName} (IAM.md §7.2).`,
					createdBy,
					this.ctx.now(),
				],
			);
			this.ctx.sqlite.run('UPDATE pipeline_repositories SET service_account_id = ? WHERE id = ? AND org_id = ?', [
				id,
				repositoryId,
				orgId,
			]);
			return { id, name, created: true };
		}
		throw new ConflictError('Could not allocate a unique pipeline service-account name.');
	}

	/** The org slug registry namespaces use (`<slug>/<repository>`), or null before org setup. */
	#orgSlug(orgId: string): string | null {
		try {
			return (
				this.ctx.sqlite
					.query<{ slug: string }, [string]>('SELECT slug FROM organization WHERE id = ? LIMIT 1')
					.get(orgId)?.slug ?? null
			);
		} catch {
			return null;
		}
	}

	#linkedProjectIds(repositoryId: string): string[] {
		return this.ctx.sqlite
			.query<{ project_id: string }, [string]>('SELECT project_id FROM pipeline_project_links WHERE repository_id = ?')
			.all(repositoryId)
			.map((row) => row.project_id);
	}

	/**
	 * A managed custom role with exactly `permissions`. An existing row with the reserved name is
	 * corrected rather than duplicated, so a dashboard edit cannot widen a pipeline by accident.
	 */
	#ensureManagedRole(
		orgId: string,
		name: string,
		permissions: readonly Permission[],
		createdBy: string,
	): { id: string; changed: boolean } {
		const expected = [...permissions].sort();
		const row = this.ctx.sqlite
			.query<{ id: string; permissions_json: string }, [string, string]>(
				'SELECT id, permissions_json FROM iam_roles WHERE org_id = ? AND name = ?',
			)
			.get(orgId, name);
		if (row) {
			if (samePermissions(row.permissions_json, expected)) return { id: row.id, changed: false };
			this.ctx.sqlite.run('UPDATE iam_roles SET permissions_json = ?, updated_at = ? WHERE id = ?', [
				JSON.stringify(expected),
				this.ctx.now(),
				row.id,
			]);
			return { id: row.id, changed: true };
		}
		const id = newId('role_');
		const now = this.ctx.now();
		this.ctx.sqlite.run(
			`INSERT INTO iam_roles
			   (id, org_id, name, description, permissions_json, built_in, created_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
			[id, orgId, name, `Managed by pipeline provisioning (${name}).`, JSON.stringify(expected), createdBy, now, now],
		);
		return { id, changed: false };
	}

	#ensureBinding(
		orgId: string,
		serviceAccountId: string,
		roleId: string,
		scopeType: string,
		scopeId: string,
	): boolean {
		const existing = this.ctx.sqlite
			.query<{ id: string }, [string, string, string, string, string]>(
				`SELECT id FROM iam_bindings
				  WHERE org_id = ? AND principal_type = 'serviceAccount' AND principal_id = ?
				    AND role_id = ? AND scope_type = ? AND scope_id = ?
				  LIMIT 1`,
			)
			.get(orgId, serviceAccountId, roleId, scopeType, scopeId);
		if (existing) return false;
		this.ctx.sqlite.run(
			`INSERT INTO iam_bindings
			   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, scope_parent_id,
			    condition_json, expires_at, reason, created_by, created_at)
			 VALUES (?, ?, 'serviceAccount', ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
			[
				newId('bind_'),
				orgId,
				serviceAccountId,
				roleId,
				scopeType,
				scopeId,
				'Per-repository pipeline account (IAM.md §7.2).',
				PIPELINE_PROVISIONER,
				this.ctx.now(),
			],
		);
		return true;
	}

	/** Drop provisioned bindings that no longer match the repository's current links. */
	#pruneManagedBindings(
		orgId: string,
		serviceAccountId: string,
		keep: {
			repositoryId: string;
			imageRepository: string | null;
			projectIds: ReadonlySet<string>;
			roles: { repository: string; deploy: string; image: string };
		},
	): number {
		const rows = this.ctx.sqlite
			.query<{ id: string; role_id: string; scope_type: string; scope_id: string | null }, [string, string, string, string, string, string]>(
				`SELECT id, role_id, scope_type, scope_id FROM iam_bindings
				  WHERE org_id = ? AND principal_type = 'serviceAccount' AND principal_id = ?
				    AND created_by = ? AND role_id IN (?, ?, ?)`,
			)
			.all(orgId, serviceAccountId, PIPELINE_PROVISIONER, keep.roles.repository, keep.roles.deploy, keep.roles.image);
		let removed = 0;
		for (const row of rows) {
			const retained =
				(row.role_id === keep.roles.repository &&
					row.scope_type === 'pipelineRepository' &&
					row.scope_id === keep.repositoryId) ||
				(row.role_id === keep.roles.image &&
					keep.imageRepository !== null &&
					row.scope_type === 'repository' &&
					row.scope_id === keep.imageRepository) ||
				(row.role_id === keep.roles.deploy &&
					row.scope_type === 'project' &&
					row.scope_id !== null &&
					keep.projectIds.has(row.scope_id));
			if (retained) continue;
			this.ctx.sqlite.run('DELETE FROM iam_bindings WHERE id = ?', [row.id]);
			removed++;
		}
		return removed;
	}

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
	const audience = value?.trim() || 'yoal';
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

/**
 * `pipeline-<repo>` within the 40-character service-account slug limit. A long or non-slug
 * repository name keeps a stable hash suffix, and `attempt` disambiguates two names that slugify
 * the same without ever sharing an account.
 */
function pipelineAccountName(repositoryName: string, attempt = 0): string {
	const slug =
		repositoryName
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'repo';
	const base = `pipeline-${slug}`;
	if (attempt === 0 && base.length <= SLUG_MAX && SLUG_PATTERN.test(base)) return base;
	const suffix = sha256Hex(attempt === 0 ? repositoryName : `${repositoryName}:${attempt}`).slice(0, 8);
	const stem = base.slice(0, SLUG_MAX - suffix.length - 1).replace(/-+$/g, '') || 'pipeline';
	return `${stem}-${suffix}`;
}

/** Whether a role's stored JSON names exactly the expected permission set. */
function samePermissions(json: string, expected: readonly string[]): boolean {
	try {
		const value: unknown = JSON.parse(json);
		if (!Array.isArray(value) || value.length !== expected.length) return false;
		const stored = new Set(value.filter((entry): entry is string => typeof entry === 'string'));
		return stored.size === expected.length && expected.every((permission) => stored.has(permission));
	} catch {
		return false;
	}
}

/** The in-process actor for provisioning a repository's pipeline account. */
function pipelineProvisioner(orgId: string): Principal {
	return {
		kind: 'system',
		userId: PIPELINE_PROVISIONER,
		orgId,
		role: 'viewer',
		permissions: new Set<Permission>(),
		credential: 'system',
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

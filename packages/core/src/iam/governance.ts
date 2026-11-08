/**
 * Governance (IAM.md I11/I22, §9.2–§9.4): org deny guardrails and just-in-time access.
 *
 * Guardrails are deny rules. The decision engine already loads rows from `iam_guardrails`
 * (`IamService.guardrails`); this module owns writing them. A guardrail beats every allow, so a
 * write here is audited and bumps the org's `iamVersion` in the same transaction, which drops the
 * compiled-grant cache.
 *
 * Just-in-time access is the audited alternative to standing production access: someone asks for a
 * role at a scope for at most eight hours with a reason, and an approver who is not the requester
 * (and who holds `iam:manage-bindings` at that scope) turns it into a time-boxed binding.
 *
 * Both are deliberately small: templates cover the common rules (§9.2), custom rows are allowed,
 * and a pending request expires after 24 hours without a sweep.
 */
import type { Database } from 'bun:sqlite';
import {
	allPermissions,
	isPermission,
	permissionCatalog,
	permissionsWithRisk,
	statements,
	type Condition,
	type CredentialKind,
	type Principal,
	type ResourceRef,
	type ScopeRef
} from '@skiff/contracts';
import type { CoreContext } from '../context.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { newId } from '../util.ts';

/** An approved binding may not outlive this. The org maximum is one constant for now (I22). */
export const MAX_DURATION_SECONDS = 8 * 60 * 60;
/** A pending request left undecided for this long becomes `expired` on the next read. */
export const REQUEST_TTL_SECONDS = 24 * 60 * 60;

const REQUEST_TTL_MS = REQUEST_TTL_SECONDS * 1000;

const CREDENTIAL_KINDS: readonly CredentialKind[] = [
	'session',
	'apiKey',
	'oauth',
	'sts',
	'workload',
	'job',
	'node',
	'system'
];

/** Credentials that are not a person at a keyboard, for "production needs a human". */
const NON_SESSION_CREDENTIALS: readonly CredentialKind[] = [
	'apiKey',
	'oauth',
	'sts',
	'workload',
	'job',
	'node',
	'system'
];

const PRINCIPAL_TYPES = [
	'user',
	'group',
	'serviceAccount',
	'workload',
	'job',
	'mcp',
	'node',
	'system'
] as const;

const SELECTOR_KEYS = new Set(['principalTypes', 'principalIds', 'groupIds']);
const RESOURCES = new Set(Object.keys(statements));
const RESOURCE_SCOPE_TYPES = new Set([
	'deployment',
	'secret',
	'build',
	'database',
	'storage',
	'broker',
	'emailDomain',
	'shareLink',
	'container',
	'repository',
	'pipelineRepository',
	'userPool',
	'accessPolicy',
	'apiKey'
]);

// -------------------------------------------------------------------- guardrail templates

export type GuardrailTemplateKey =
	'no-secrets-to-robots' | 'production-needs-a-human' | 'no-destructive-mcp' | 'office-only';

/** `{}` means every principal; the engine matches the values it knows today. */
export interface PrincipalSelector {
	principalTypes?: readonly string[];
	principalIds?: readonly string[];
	groupIds?: readonly string[];
}

export interface GuardrailTemplate {
	key: GuardrailTemplateKey;
	name: string;
	description: string;
	selector: PrincipalSelector;
	permissions: readonly string[];
	condition: Condition | null;
	/** False when the engine cannot express the rule yet; the reason is in `note`. */
	available: boolean;
	note?: string;
}

const CREDENTIAL_PERMISSIONS = allPermissions.filter((permission) =>
	permission.endsWith(':credentials')
);
const DESTRUCTIVE_PERMISSIONS = permissionsWithRisk(permissionCatalog, 'destructive');

/**
 * The four rules in IAM.md §9.2. Two are shaped by the current engine and say so in `note`:
 * the pure evaluator has one AND-ed condition per guardrail and no negation, and `IamService`
 * selects by binding principal type (`user` / `group` / `serviceAccount`), not principal kind.
 */
export const GUARDRAIL_TEMPLATES: readonly GuardrailTemplate[] = [
	{
		key: 'no-secrets-to-robots',
		name: 'No secrets to robots',
		description:
			'Deny every credential-revealing permission, and container shells, to service accounts, workloads and jobs.',
		selector: { principalTypes: ['serviceAccount', 'workload', 'job'] },
		permissions: [...CREDENTIAL_PERMISSIONS, 'container:exec'],
		condition: null,
		available: true
	},
	{
		key: 'production-needs-a-human',
		name: 'Production needs a human',
		description:
			'Deny deployment promotion to API keys, OAuth tokens and machine credentials. Scope it to the production project.',
		selector: {},
		permissions: ['deployment:promote'],
		// "unless credentialIn: [session]" is stored as the non-session list: the engine can only
		// say "deny when this condition holds". A request without credential context is not denied.
		condition: { op: 'credentialIn', credentials: NON_SESSION_CREDENTIALS },
		available: true,
		note: 'Fires when the request carries a non-session credential. Scope it to the production project; per-environment guardrails need the parent column.'
	},
	{
		key: 'no-destructive-mcp',
		name: 'No destructive MCP',
		description: 'Deny every destructive permission to MCP clients.',
		selector: { principalTypes: ['mcp'] },
		permissions: DESTRUCTIVE_PERMISSIONS,
		condition: null,
		available: true,
		note: 'The selector is stored as written. The engine currently selects by binding type, which maps MCP to user, so it becomes effective once `IamService` passes principal kinds.'
	},
	{
		key: 'office-only',
		name: 'Office only',
		description: 'Deny everything unless the request comes from one of the listed office networks.',
		selector: {},
		permissions: ['all'],
		condition: null,
		// The rule is "deny unless ipIn", and the engine has no negated condition. An `ipNotIn`
		// condition it does not understand is skipped, so the guardrail would be inert rather than
		// protecting anything. Refusing to create it is the honest option until §5.4 grows negation.
		available: false,
		note: 'Not available yet: this needs a negated IP condition (`ipNotIn`), which the decision engine does not support. It is listed so the rule is not silently lost.'
	}
] as const;

// ------------------------------------------------------------------------------ views

export interface GuardrailView {
	id: string;
	/** Null for a platform guardrail; only an org row can be edited here. */
	orgId: string | null;
	name: string;
	selector: PrincipalSelector;
	permissions: string[];
	scope: ScopeRef | null;
	condition: Condition | null;
	enabled: boolean;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
}

export type AccessRequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired';

export interface AccessRequestView {
	id: string;
	requesterId: string;
	roleId: string;
	roleName: string;
	scope: ScopeRef;
	durationSeconds: number;
	reason: string;
	changeRef: string | null;
	status: AccessRequestStatus;
	decidedBy: string | null;
	decidedAt: number | null;
	bindingId: string | null;
	/** When the approved binding stops granting, or null while undecided. */
	expiresAt: number | null;
	createdAt: number;
	/** `createdAt` plus 24 hours; a pending request past this is expired. */
	requestExpiresAt: number;
	/** The caller may approve or deny this: pending, someone else's, and permitted at its scope. */
	canDecide: boolean;
	/** The caller made it and it is still pending or approved. */
	canCancel: boolean;
}

export interface GuardrailCreate {
	template?: GuardrailTemplateKey | string;
	name?: string;
	permissions?: readonly string[];
	selector?: PrincipalSelector;
	scope?: ScopeRef;
	condition?: Condition | null;
	enabled?: boolean;
}

export interface GuardrailUpdate {
	name?: string;
	permissions?: readonly string[];
	selector?: PrincipalSelector;
	scope?: ScopeRef;
	condition?: Condition | null;
	enabled?: boolean;
}

export interface AccessRequestCreate {
	roleId: string;
	scope: ScopeRef;
	durationSeconds: number;
	reason: string;
	changeRef?: string;
}

export interface AccessRequestListOptions {
	status?: AccessRequestStatus;
}

// ------------------------------------------------------------------------------- rows

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

interface AccessRequestRow {
	id: string;
	org_id: string;
	requester_id: string;
	role_id: string;
	scope_type: string;
	scope_id: string | null;
	scope_parent_id: string | null;
	duration_seconds: number;
	reason: string;
	change_ref: string | null;
	status: string;
	decided_by: string | null;
	decided_at: number | null;
	binding_id: string | null;
	created_at: number;
	binding_expires_at: number | null;
}

// ----------------------------------------------------------------------------- service

export class GovernanceService {
	readonly #sqlite: Database;

	constructor(private readonly ctx: CoreContext) {
		this.#sqlite = ctx.sqlite;
	}

	// ------------------------------------------------------------- guardrails: reads

	/** The org's guardrails plus read-only platform rows. `iam:read` is enough to see them. */
	list(principal: Principal): GuardrailView[];
	/** Pending and decided requests the caller may see (see `#listRequests`). */
	list(principal: Principal, options: AccessRequestListOptions): AccessRequestView[];
	list(
		principal: Principal,
		options?: AccessRequestListOptions
	): GuardrailView[] | AccessRequestView[] {
		if (options === undefined) {
			this.ctx.iam.require(principal, 'iam:read', { type: 'org' });
			return this.#sqlite
				.query<GuardrailRow, [string]>(
					`SELECT * FROM iam_guardrails
           WHERE org_id = ? OR org_id IS NULL
           ORDER BY org_id IS NULL, name COLLATE NOCASE`
				)
				.all(principal.orgId)
				.map(guardrailView);
		}
		return this.#listRequests(principal, options);
	}

	// ------------------------------------------------------------ guardrails: writes

	create(principal: Principal, input: GuardrailCreate): GuardrailView {
		this.ctx.iam.require(principal, 'iam:manage-guardrails', { type: 'org' });

		let permissions: string[];
		let selector: PrincipalSelector;
		let condition: Condition | null;
		let name = input.name?.trim() ?? '';

		if (input.template) {
			if (input.permissions || input.selector || input.condition !== undefined)
				throw new ValidationError(
					'A template supplies its permissions, selector and condition. Omit them, or create a custom guardrail without a template.'
				);
			const template = GUARDRAIL_TEMPLATES.find((entry) => entry.key === input.template);
			if (!template) throw new ValidationError(`"${input.template}" is not a guardrail template.`);
			if (!template.available)
				throw new ValidationError(template.note ?? 'That guardrail template is not available yet.');
			permissions = [...template.permissions];
			selector = cloneSelector(template.selector);
			condition = template.condition;
			if (!name) name = template.name;
		} else {
			permissions = validatePermissions(input.permissions ?? []);
			selector = validateSelector(input.selector ?? {});
			condition = validateCondition(input.condition ?? null);
		}

		name = validateName(name);
		const scope = validateGuardrailScope(input.scope ?? { type: 'org' });
		const row = scopeToRow(scope);
		if (this.#nameTaken(principal.orgId, name))
			throw new ConflictError(`A guardrail named "${name}" already exists.`);

		const id = newId('grd_');
		const now = this.ctx.now();
		this.#sqlite.transaction(() => {
			this.#sqlite.run(
				`INSERT INTO iam_guardrails
           (id, org_id, name, principal_selector_json, permissions_json, scope_type, scope_id,
            condition_json, enabled, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					principal.orgId,
					name,
					JSON.stringify(selector),
					JSON.stringify(permissions),
					row.type,
					row.id,
					condition ? JSON.stringify(condition) : null,
					input.enabled === false ? 0 : 1,
					principal.userId,
					now,
					now
				]
			);
			this.ctx.iam.touch(principal.orgId);
		})();
		this.ctx.audit.record({
			principal,
			action: 'iam.guardrail.create',
			resource: 'iam_guardrail',
			resourceId: id,
			args: {
				name,
				template: input.template ?? null,
				permissions,
				selector,
				scope,
				condition,
				enabled: input.enabled !== false
			},
			result: 'ok'
		});
		return guardrailView({
			id,
			org_id: principal.orgId,
			name,
			principal_selector_json: JSON.stringify(selector),
			permissions_json: JSON.stringify(permissions),
			scope_type: row.type,
			scope_id: row.id,
			condition_json: condition ? JSON.stringify(condition) : null,
			enabled: input.enabled === false ? 0 : 1,
			created_by: principal.userId,
			created_at: now,
			updated_at: now
		});
	}

	update(principal: Principal, id: string, input: GuardrailUpdate): GuardrailView {
		this.ctx.iam.require(principal, 'iam:manage-guardrails', { type: 'org' });
		const row = this.#guardrailRow(principal, id);
		const before = guardrailView(row);

		const sets: string[] = [];
		const values: Array<string | number | null> = [];
		const set = (column: string, value: string | number | null) => {
			sets.push(`${column} = ?`);
			values.push(value);
		};

		if (input.name !== undefined) {
			const name = validateName(input.name);
			if (name !== row.name) {
				if (this.#nameTaken(principal.orgId, name, id))
					throw new ConflictError(`A guardrail named "${name}" already exists.`);
				set('name', name);
			}
		}
		if (input.permissions !== undefined)
			set('permissions_json', JSON.stringify(validatePermissions(input.permissions)));
		if (input.selector !== undefined)
			set('principal_selector_json', JSON.stringify(validateSelector(input.selector)));
		if (input.condition !== undefined) {
			const condition = validateCondition(input.condition);
			set('condition_json', condition ? JSON.stringify(condition) : null);
		}
		if (input.scope !== undefined) {
			const scope = validateGuardrailScope(input.scope);
			const scoped = scopeToRow(scope);
			set('scope_type', scoped.type);
			set('scope_id', scoped.id);
		}
		if (input.enabled !== undefined) set('enabled', input.enabled ? 1 : 0);

		if (sets.length === 0) return before;

		const now = this.ctx.now();
		set('updated_at', now);
		this.#sqlite.transaction(() => {
			this.#sqlite.run(`UPDATE iam_guardrails SET ${sets.join(', ')} WHERE id = ?`, [
				...values,
				id
			]);
			this.ctx.iam.touch(principal.orgId);
		})();
		const after = guardrailView(this.#guardrailRow(principal, id));
		this.ctx.audit.record({
			principal,
			action: 'iam.guardrail.update',
			resource: 'iam_guardrail',
			resourceId: id,
			args: { before, after },
			result: 'ok'
		});
		return after;
	}

	delete(principal: Principal, id: string): void {
		this.ctx.iam.require(principal, 'iam:manage-guardrails', { type: 'org' });
		const row = this.#guardrailRow(principal, id);
		this.#sqlite.transaction(() => {
			this.#sqlite.run('DELETE FROM iam_guardrails WHERE id = ?', [id]);
			this.ctx.iam.touch(principal.orgId);
		})();
		this.ctx.audit.record({
			principal,
			action: 'iam.guardrail.delete',
			resource: 'iam_guardrail',
			resourceId: id,
			args: { name: row.name, permissions: parseStrings(row.permissions_json) },
			result: 'ok'
		});
	}

	// ---------------------------------------------------------------- just-in-time reads

	/**
	 * Pending and decided requests the caller may see: their own, plus every request they may decide
	 * at its scope. Pending requests older than 24 hours are marked `expired` first. No IAM
	 * permission is needed: the filter is the authorization.
	 */
	#listRequests(principal: Principal, options: AccessRequestListOptions): AccessRequestView[] {
		this.#expireStale(principal.orgId);
		const roleNames = this.#roleNames(principal.orgId);
		const rows = this.#sqlite
			.query<AccessRequestRow, [string]>(
				`SELECT r.*, b.expires_at AS binding_expires_at
         FROM access_requests r
         LEFT JOIN iam_bindings b ON b.id = r.binding_id
         WHERE r.org_id = ?
         ORDER BY r.created_at DESC`
			)
			.all(principal.orgId);

		return rows.flatMap((row) => {
			const scope = scopeFromRow(row);
			if (!scope) return [];
			// Visibility is "mine or mine to decide", independent of the request's current status,
			// so an approver still sees the decided history in their scope.
			const visible =
				row.requester_id === principal.userId ||
				this.ctx.iam.can(principal, 'iam:manage-bindings', resourceForScope(scope));
			if (!visible) return [];
			const view = this.#requestView(row, scope, principal, roleNames);
			if (options.status && view.status !== options.status) return [];
			return [view];
		});
	}

	// --------------------------------------------------------------- just-in-time writes

	/** Ask for a time-boxed role. Anyone in the org may ask, including an agent on their behalf. */
	request(principal: Principal, input: AccessRequestCreate): AccessRequestView {
		const roles = this.ctx.iam.listRoles(principal.orgId);
		if (!roles.some((role) => role.id === input.roleId))
			throw new ValidationError(`Unknown role "${input.roleId}".`);

		const scope = validateRequestScope(input.scope);
		const scoped = scopeToRow(scope);
		const durationSeconds = validDuration(input.durationSeconds);
		const reason = validateReason(input.reason);
		const changeRef = validateChangeRef(input.changeRef);

		const duplicate = this.#sqlite
			.query<{ id: string }, [string, string, string, string, string | null, string | null]>(
				`SELECT id FROM access_requests
         WHERE org_id = ? AND requester_id = ? AND role_id = ? AND scope_type = ?
           AND scope_id IS ? AND scope_parent_id IS ? AND status = 'pending'
         LIMIT 1`
			)
			.get(
				principal.orgId,
				principal.userId,
				input.roleId,
				scoped.type,
				scoped.id,
				scoped.parentId
			);
		if (duplicate)
			throw new ConflictError('You already have a pending request for that role at that scope.');

		const id = newId('req_');
		const now = this.ctx.now();
		this.#sqlite.run(
			`INSERT INTO access_requests
         (id, org_id, requester_id, role_id, scope_type, scope_id, scope_parent_id,
          duration_seconds, reason, change_ref, status, decided_by, decided_at, binding_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?)`,
			[
				id,
				principal.orgId,
				principal.userId,
				input.roleId,
				scoped.type,
				scoped.id,
				scoped.parentId,
				durationSeconds,
				reason,
				changeRef,
				now
			]
		);
		this.ctx.audit.record({
			principal,
			action: 'access.request',
			resource: 'access_request',
			resourceId: id,
			args: { roleId: input.roleId, scope, durationSeconds, reason, changeRef },
			result: 'ok'
		});
		return this.#requestView(
			{
				id,
				org_id: principal.orgId,
				requester_id: principal.userId,
				role_id: input.roleId,
				scope_type: scoped.type,
				scope_id: scoped.id,
				scope_parent_id: scoped.parentId,
				duration_seconds: durationSeconds,
				reason,
				change_ref: changeRef,
				status: 'pending',
				decided_by: null,
				decided_at: null,
				binding_id: null,
				created_at: now,
				binding_expires_at: null
			},
			scope,
			principal,
			this.#roleNames(principal.orgId)
		);
	}

	approve(principal: Principal, id: string): AccessRequestView {
		const row = this.#decidableRow(principal, id);
		if (row.requester_id === principal.userId)
			throw new ForbiddenError(
				'iam:manage-bindings',
				'the requester cannot approve their own request'
			);

		const scope = scopeFromRow(row);
		if (!scope) throw new ValidationError('That request has an invalid scope.');
		this.ctx.iam.require(principal, 'iam:manage-bindings', resourceForScope(scope));

		const role = this.ctx.iam.listRoles(principal.orgId).find((entry) => entry.id === row.role_id);
		if (!role) throw new ValidationError(`Unknown role "${row.role_id}".`);

		const now = this.ctx.now();
		const expiresAt = now + row.duration_seconds * 1000;
		const binding = this.ctx.iam.bind(principal, {
			principalType: row.requester_id.startsWith('sa_') ? 'serviceAccount' : 'user',
			principalId: row.requester_id,
			roleId: row.role_id,
			scope,
			expiresAt,
			reason: row.reason
		});

		this.#sqlite.transaction(() => {
			this.#sqlite.run('UPDATE iam_bindings SET access_request_id = ? WHERE id = ?', [
				row.id,
				binding.id
			]);
			this.#sqlite.run(
				`UPDATE access_requests
         SET status = 'approved', decided_by = ?, decided_at = ?, binding_id = ?
         WHERE id = ? AND status = 'pending'`,
				[principal.userId, now, binding.id, row.id]
			);
			this.ctx.iam.touch(principal.orgId);
		})();
		this.ctx.audit.record({
			principal,
			action: 'access.approve',
			resource: 'access_request',
			resourceId: row.id,
			args: {
				bindingId: binding.id,
				requesterId: row.requester_id,
				roleId: row.role_id,
				scope,
				expiresAt
			},
			result: 'ok'
		});
		return this.#requestFor(principal, row.id);
	}

	deny(principal: Principal, id: string): AccessRequestView {
		const row = this.#decidableRow(principal, id);
		if (row.requester_id === principal.userId)
			throw new ForbiddenError(
				'iam:manage-bindings',
				'the requester cannot decide their own request'
			);
		const scope = scopeFromRow(row);
		if (!scope) throw new ValidationError('That request has an invalid scope.');
		this.ctx.iam.require(principal, 'iam:manage-bindings', resourceForScope(scope));

		const now = this.ctx.now();
		this.#sqlite.run(
			`UPDATE access_requests
       SET status = 'denied', decided_by = ?, decided_at = ?
       WHERE id = ? AND status = 'pending'`,
			[principal.userId, now, row.id]
		);
		this.ctx.audit.record({
			principal,
			action: 'access.deny',
			resource: 'access_request',
			resourceId: row.id,
			args: { requesterId: row.requester_id, roleId: row.role_id, scope, reason: row.reason },
			result: 'ok'
		});
		return this.#requestFor(principal, row.id);
	}

	/** The requester ends a request, or an approved grant early. */
	cancel(principal: Principal, id: string): AccessRequestView {
		const row = this.#requestRow(principal.orgId, id);
		if (!row) throw new NotFoundError('Access request');
		if (row.requester_id !== principal.userId)
			throw new ForbiddenError('iam:manage-bindings', 'only the requester can cancel a request');
		if (row.status !== 'pending' && row.status !== 'approved')
			throw new ConflictError(`This access request is already ${row.status}.`);

		const now = this.ctx.now();
		this.#sqlite.transaction(() => {
			if (row.binding_id) {
				this.#sqlite.run(`DELETE FROM iam_bindings WHERE id = ? AND access_request_id = ?`, [
					row.binding_id,
					row.id
				]);
				this.ctx.iam.touch(principal.orgId);
			}
			this.#sqlite.run(
				`UPDATE access_requests SET status = 'cancelled', decided_by = ?, decided_at = ?
         WHERE id = ? AND status IN ('pending', 'approved')`,
				[principal.userId, now, row.id]
			);
		})();
		this.ctx.audit.record({
			principal,
			action: 'access.cancel',
			resource: 'access_request',
			resourceId: row.id,
			args: { status: row.status, bindingId: row.binding_id },
			result: 'ok'
		});
		return this.#requestFor(principal, row.id);
	}

	// ------------------------------------------------------------------------- internals

	#guardrailRow(principal: Principal, id: string): GuardrailRow {
		const row = this.#sqlite
			.query<GuardrailRow, [string, string]>(
				'SELECT * FROM iam_guardrails WHERE id = ? AND org_id = ?'
			)
			.get(id, principal.orgId);
		if (!row) throw new NotFoundError('Guardrail');
		return row;
	}

	#nameTaken(orgId: string, name: string, exceptId?: string): boolean {
		const row = exceptId
			? this.#sqlite
					.query(
						'SELECT 1 FROM iam_guardrails WHERE org_id = ? AND lower(name) = lower(?) AND id != ?'
					)
					.get(orgId, name, exceptId)
			: this.#sqlite
					.query('SELECT 1 FROM iam_guardrails WHERE org_id = ? AND lower(name) = lower(?)')
					.get(orgId, name);
		return row !== null;
	}

	#requestRow(orgId: string, id: string): AccessRequestRow | undefined {
		return (
			this.#sqlite
				.query<AccessRequestRow, [string, string]>(
					`SELECT r.*, b.expires_at AS binding_expires_at
           FROM access_requests r
           LEFT JOIN iam_bindings b ON b.id = r.binding_id
           WHERE r.id = ? AND r.org_id = ?`
				)
				.get(id, orgId) ?? undefined
		);
	}

	#requestFor(principal: Principal, id: string): AccessRequestView {
		const row = this.#requestRow(principal.orgId, id);
		if (!row) throw new NotFoundError('Access request');
		const scope = scopeFromRow(row);
		if (!scope) throw new ValidationError('That request has an invalid scope.');
		return this.#requestView(row, scope, principal, this.#roleNames(principal.orgId));
	}

	/** Pending, fresh and not the caller's own. The scope permission is checked by the caller. */
	#decidableRow(principal: Principal, id: string): AccessRequestRow {
		const row = this.#requestRow(principal.orgId, id);
		if (!row) throw new NotFoundError('Access request');
		if (row.status === 'pending' && row.created_at + REQUEST_TTL_MS <= this.ctx.now()) {
			this.#sqlite.run(
				`UPDATE access_requests SET status = 'expired' WHERE id = ? AND status = 'pending'`,
				[id]
			);
			throw new ConflictError('This access request expired before it was decided.');
		}
		if (row.status !== 'pending')
			throw new ConflictError(`This access request is already ${row.status}.`);
		// IAM.md §9.4: an agent may ask, but only a human can approve.
		if (principal.kind !== 'user')
			throw new ForbiddenError('iam:manage-bindings', 'only a human session can decide a request');
		return row;
	}

	#expireStale(orgId: string): void {
		this.#sqlite.run(
			`UPDATE access_requests SET status = 'expired'
       WHERE org_id = ? AND status = 'pending' AND created_at <= ?`,
			[orgId, this.ctx.now() - REQUEST_TTL_MS]
		);
	}

	#requestView(
		row: AccessRequestRow,
		scope: ScopeRef,
		principal: Principal,
		roleNames: ReadonlyMap<string, string>
	): AccessRequestView {
		const status = row.status as AccessRequestStatus;
		const decidable =
			status === 'pending' &&
			row.requester_id !== principal.userId &&
			principal.kind === 'user' &&
			this.ctx.iam.can(principal, 'iam:manage-bindings', resourceForScope(scope));
		return {
			id: row.id,
			requesterId: row.requester_id,
			roleId: row.role_id,
			roleName: roleNames.get(row.role_id) ?? row.role_id,
			scope,
			durationSeconds: row.duration_seconds,
			reason: row.reason,
			changeRef: row.change_ref,
			status,
			decidedBy: row.decided_by,
			decidedAt: row.decided_at,
			bindingId: row.binding_id,
			expiresAt: row.binding_expires_at,
			createdAt: row.created_at,
			requestExpiresAt: row.created_at + REQUEST_TTL_MS,
			canDecide: decidable,
			canCancel:
				row.requester_id === principal.userId && (status === 'pending' || status === 'approved')
		};
	}

	#roleNames(orgId: string): Map<string, string> {
		return new Map(this.ctx.iam.listRoles(orgId).map((role) => [role.id, role.name]));
	}
}

// ------------------------------------------------------------------------ scope helpers

/** A scope as a `ResourceRef`, for the engine's `require`/`can` checks. */
export function resourceForScope(scope: ScopeRef): ResourceRef {
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

function scopeToRow(scope: ScopeRef): {
	type: string;
	id: string | null;
	parentId: string | null;
} {
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
						projectId: row.scope_parent_id ?? undefined
					} as ScopeRef)
				: undefined;
	}
}

// --------------------------------------------------------------------- validation

function validateGuardrailScope(value: unknown): ScopeRef {
	const scope = validateScope(value);
	if (scope.type === 'org') return scope;
	if (scope.type === 'project') return scope;
	throw new ValidationError(
		'A guardrail applies to the organisation or a project. Environment and single-resource guardrails need the parent column that `iam_guardrails` does not have yet.'
	);
}

function validateRequestScope(value: unknown): ScopeRef {
	const scope = validateScope(value);
	if (scope.type === 'platform')
		throw new ValidationError(
			'A just-in-time request is for an org resource; platform access is a platform-admin grant (I24).'
		);
	return scope;
}

function validateScope(value: unknown): ScopeRef {
	if (!value || typeof value !== 'object')
		throw new ValidationError('A scope is required, for example { "type": "org" }.');
	const record = value as { type?: unknown; id?: unknown; projectId?: unknown };
	const type = typeof record.type === 'string' ? record.type : '';
	const id = typeof record.id === 'string' ? record.id.trim() : '';
	const projectId = typeof record.projectId === 'string' ? record.projectId.trim() : '';

	switch (type) {
		case 'platform':
			return { type: 'platform' };
		case 'org':
			return { type: 'org' };
		case 'project':
			if (!id) throw new ValidationError('A project scope needs its project id.');
			return { type: 'project', id };
		case 'environment': {
			if (!id || !projectId)
				throw new ValidationError('An environment scope needs its environment id and project id.');
			return { type: 'environment', id, projectId };
		}
		default:
			if (!RESOURCE_SCOPE_TYPES.has(type))
				throw new ValidationError(`"${type}" is not a scope a binding can attach to.`);
			if (!id) throw new ValidationError(`A ${type} scope needs its resource id.`);
			return {
				type,
				id,
				...(projectId ? { projectId } : {})
			} as ScopeRef;
	}
}

function validDuration(value: number): number {
	if (!Number.isInteger(value) || value < 60)
		throw new ValidationError('A duration is a whole number of seconds, at least 60.');
	if (value > MAX_DURATION_SECONDS)
		throw new ValidationError(`A request may last at most ${MAX_DURATION_SECONDS / 3600} hours.`);
	return value;
}

function validateReason(raw: string): string {
	const reason = raw.trim();
	if (reason.length < 3) throw new ValidationError('Give a reason for the request.');
	if (reason.length > 500) throw new ValidationError('Keep the reason under 500 characters.');
	return reason;
}

function validateChangeRef(raw: string | undefined): string | null {
	const value = (raw ?? '').trim();
	if (value.length > 200)
		throw new ValidationError('Keep the change reference under 200 characters.');
	return value || null;
}

function validateName(raw: string): string {
	const name = raw.trim();
	if (name.length < 2 || name.length > 80)
		throw new ValidationError('A guardrail name is 2–80 characters.');
	if (/[\r\n\t]/.test(name))
		throw new ValidationError('A guardrail name must be a single line of text.');
	return name;
}

function validatePermissions(values: readonly string[]): string[] {
	const permissions = [...new Set(values.map((value) => value.trim()))];
	if (permissions.length === 0)
		throw new ValidationError('A guardrail needs at least one permission.');
	for (const permission of permissions) {
		if (permission === 'all' || permission === '*:*') continue;
		if (isPermission(permission)) continue;
		const wildcard = /^([a-zA-Z]+):\*$/.exec(permission);
		if (wildcard && RESOURCES.has(wildcard[1]!)) continue;
		throw new ValidationError(
			`"${permission}" is not a permission in the catalog or a resource wildcard such as database:*.`
		);
	}
	return permissions;
}

function validateSelector(value: unknown): PrincipalSelector {
	if (value === null || value === undefined) return {};
	if (typeof value !== 'object' || Array.isArray(value))
		throw new ValidationError('A guardrail selector must be an object.');
	const record = value as Record<string, unknown>;
	const out: { principalTypes?: string[]; principalIds?: string[]; groupIds?: string[] } = {};

	for (const key of Object.keys(record))
		if (!SELECTOR_KEYS.has(key))
			throw new ValidationError(
				`"${key}" is not a guardrail selector field; use principalTypes, principalIds or groupIds.`
			);

	if (record.principalTypes !== undefined) {
		const types = stringArray(record.principalTypes, 'principalTypes');
		for (const type of types)
			if (!(PRINCIPAL_TYPES as readonly string[]).includes(type))
				throw new ValidationError(`"${type}" is not a principal type.`);
		out.principalTypes = types;
	}
	if (record.principalIds !== undefined)
		out.principalIds = stringArray(record.principalIds, 'principalIds');
	if (record.groupIds !== undefined) out.groupIds = stringArray(record.groupIds, 'groupIds');
	return out;
}

function validateCondition(value: unknown): Condition | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'object' || Array.isArray(value))
		throw new ValidationError('A guardrail condition must be an object.');
	const record = value as Record<string, unknown>;

	switch (record.op) {
		case 'before':
		case 'after': {
			if (!Number.isInteger(record.at))
				throw new ValidationError('A before/after condition needs an epoch-millisecond `at`.');
			return { op: record.op, at: record.at as number };
		}
		case 'ipIn':
			return { op: 'ipIn', cidrs: stringArray(record.cidrs, 'cidrs') };
		case 'credentialIn': {
			const credentials = stringArray(record.credentials, 'credentials');
			for (const credential of credentials)
				if (!(CREDENTIAL_KINDS as readonly string[]).includes(credential))
					throw new ValidationError(`"${credential}" is not a credential kind.`);
			return { op: 'credentialIn', credentials: credentials as CredentialKind[] };
		}
		case 'environmentIn':
			return {
				op: 'environmentIn',
				environments: stringArray(record.environments, 'environments')
			};
		case 'freshAuth': {
			if (record.class !== 'strong' && record.class !== 'basic')
				throw new ValidationError('A freshAuth condition needs class "strong" or "basic".');
			return { op: 'freshAuth', class: record.class };
		}
		default:
			throw new ValidationError(
				`"${String(record.op)}" is not a condition the decision engine understands.`
			);
	}
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.length === 0)
		throw new ValidationError(`\`${field}\` must be a non-empty array of strings.`);
	return value.map((entry) => {
		if (typeof entry !== 'string' || entry.trim() === '')
			throw new ValidationError(`\`${field}\` must be a non-empty array of strings.`);
		return entry.trim();
	});
}

// --------------------------------------------------------------------------- parsing

function cloneSelector(selector: PrincipalSelector): PrincipalSelector {
	return {
		...(selector.principalTypes ? { principalTypes: [...selector.principalTypes] } : {}),
		...(selector.principalIds ? { principalIds: [...selector.principalIds] } : {}),
		...(selector.groupIds ? { groupIds: [...selector.groupIds] } : {})
	};
}

function guardrailView(row: GuardrailRow): GuardrailView {
	const scope =
		row.scope_type === null
			? null
			: scopeFromRow({
					scope_type: row.scope_type,
					scope_id: row.scope_id,
					scope_parent_id: null
				});
	return {
		id: row.id,
		orgId: row.org_id,
		name: row.name,
		selector: parseSelector(row.principal_selector_json),
		permissions: parseStrings(row.permissions_json),
		scope: scope ?? null,
		condition: parseCondition(row.condition_json),
		enabled: row.enabled !== 0,
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function parseSelector(json: string): PrincipalSelector {
	try {
		const value: unknown = JSON.parse(json);
		if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
		return value as PrincipalSelector;
	} catch {
		return {};
	}
}

function parseStrings(json: string): string[] {
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
		return null;
	}
}

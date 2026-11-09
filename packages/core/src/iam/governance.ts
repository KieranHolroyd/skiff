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
	type Permission,
	type Principal,
	type ResourceRef,
	type ScopeRef
} from '@skiff/contracts';
import type { CoreContext } from '../context.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { notifyIam, type IamNotification } from '../notify.ts';
import { SERVICE_ACCOUNT_UNUSED_DAYS } from '../service-accounts.ts';
import { newId } from '../util.ts';

/** An approved binding may not outlive this. The org maximum is one constant for now (I22). */
export const MAX_DURATION_SECONDS = 8 * 60 * 60;
/** A pending request left undecided for this long becomes `expired` on the next read. */
export const REQUEST_TTL_SECONDS = 24 * 60 * 60;

/** The usage rollup looks back this far into `audit_log` on every run. */
export const USAGE_WINDOW_DAYS = 30;
/** "Shorten" in an access review leaves the binding with at most this long to live (IAM.md §9.5). */
export const REVIEW_SHORTEN_DAYS = 30;

const REQUEST_TTL_MS = REQUEST_TTL_SECONDS * 1000;
const USAGE_WINDOW_MS = USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const REVIEW_SHORTEN_MS = REVIEW_SHORTEN_DAYS * 24 * 60 * 60 * 1000;

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

export type ReviewStatus = 'open' | 'completed';
export type ReviewDecision = 'keep' | 'revoke' | 'shorten';
export type ReviewDefaultDecision = 'keep' | 'revoke';

export interface AccessReviewCreate {
  scope: ScopeRef;
  name?: string;
  /** Applied to every undecided item when the campaign completes. Defaults to `keep`. */
  defaultDecision?: ReviewDefaultDecision;
  dueAt?: number;
}

export interface AccessReviewItemView {
  id: string;
  reviewId: string;
  bindingId: string;
  principalType: string;
  principalId: string;
  roleId: string;
  roleName: string;
  scope: ScopeRef;
  condition: Condition | null;
  expiresAt: number | null;
  /** A scope manager the campaign assigned this item to; a hint, not an authorization. */
  reviewerId: string | null;
  decision: ReviewDecision | null;
  decidedBy: string | null;
  decidedAt: number | null;
  /** The newest audit-derived use of any permission in the binding's role, or null. */
  lastUsedAt: number | null;
  /** Whole days since `lastUsedAt`, or null when there is no use in the 30-day rollup. */
  unusedDays: number | null;
}

export interface AccessReviewView {
  id: string;
  name: string;
  scope: ScopeRef;
  status: ReviewStatus;
  defaultDecision: ReviewDefaultDecision;
  dueAt: number | null;
  createdBy: string;
  createdAt: number;
  completedBy: string | null;
  completedAt: number | null;
  items: AccessReviewItemView[];
  /** The caller may decide items and complete the campaign. */
  canDecide: boolean;
  /** Open campaigns this caller has an item in, for the "needs your review" hint. */
  assignedToMe: number;
  /** Open and past `dueAt`; the daily sweep completes it with the campaign default. */
  overdue: boolean;
}

export interface AccessReviewSweep {
	/** Open campaigns whose deadline has passed. */
	flagged: number;
	/** Campaigns the sweep completed successfully. */
	completed: number;
}

export interface AccessReviewListOptions {
  status?: ReviewStatus;
}

export interface PermissionUsageView {
  principalType: string;
  principalId: string;
  permission: string;
  scopeType: string;
  scopeId: string | null;
  lastUsedAt: number;
  count30d: number;
}

export interface UsageRollupResult {
  /** Organisations whose usage rows were replaced. */
  orgs: number;
  /** Aggregate rows written. */
  rows: number;
  /** Inclusive lower bound of the audit window, epoch ms. */
  from: number;
  /** Upper bound of the audit window, epoch ms. */
  to: number;
}

/** A service account the daily hygiene pass considers unused (IAM.md §9.5). */
export interface UnusedServiceAccountView {
  id: string;
  name: string;
  ownerGroupId: string | null;
  disabled: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  unusedDays: number;
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

interface AccessReviewRow {
  id: string;
  org_id: string;
  name: string;
  scope_type: string;
  scope_id: string | null;
  scope_parent_id: string | null;
  status: string;
  default_decision: string;
  due_at: number | null;
  created_by: string;
  created_at: number;
  completed_by: string | null;
  completed_at: number | null;
}

interface AccessReviewItemRow {
  id: string;
  review_id: string;
  org_id: string;
  binding_id: string;
  principal_type: string;
  principal_id: string;
  role_id: string;
  role_name: string;
  scope_type: string;
  scope_id: string | null;
  scope_parent_id: string | null;
  condition_json: string | null;
  expires_at: number | null;
  reviewer_id: string | null;
  decision: string | null;
  decided_by: string | null;
  decided_at: number | null;
  created_at: number;
}

interface PermissionUsageRow {
  org_id: string;
  principal_type: string;
  principal_id: string;
  permission: string;
  scope_type: string;
  scope_id: string | null;
  last_used_at: number;
  count_30d: number;
}

interface AuditUsageRow {
  org_id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  created_at: number;
}

interface BindingSnapshotRow {
  id: string;
  principal_type: string;
  principal_id: string;
  role_id: string;
  scope_type: string;
  scope_id: string | null;
  scope_parent_id: string | null;
  condition_json: string | null;
  expires_at: number | null;
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
		const roleName = roles.find((role) => role.id === input.roleId)?.name ?? input.roleId;
		this.#notify({
			key: `iam:access-request:${id}`,
			title: `Access request: ${roleName} at ${scopeLabel(scope)}`,
			detail: [
				`${principal.userId} requested ${roleName} at ${scopeLabel(scope)} for ${formatDuration(durationSeconds)}.`,
				`Reason: ${reason}`,
				changeRef ? `Change reference: ${changeRef}` : null,
				this.#approversLine(principal.orgId, scope, principal.userId),
				`Request ${id}; it expires ${formatTime(now + REQUEST_TTL_MS)}. Approve or deny it in Skiff → Access.`
			]
				.filter((line): line is string => line !== null)
				.join('\n'),
			severity: 'info',
			url: this.#url(`/iam/access/${id}`),
			recipients: this.#emailsFor(
				principal.orgId,
				this.#approverIds(principal.orgId, scope, principal.userId) ?? [],
			),
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
		this.#notify({
			key: `iam:access-approved:${row.id}`,
			title: `Access approved: ${role.name} at ${scopeLabel(scope)}`,
			detail:
				`${principal.userId} approved ${row.requester_id}'s request for ${role.name} at ${scopeLabel(scope)}. ` +
				`The grant is binding ${binding.id} and expires ${formatTime(expiresAt)}.`,
			severity: 'info',
			url: this.#url(`/iam/access/${row.id}`),
			recipients: this.#emailsFor(principal.orgId, [row.requester_id]),
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
		const roleName = this.#roleNames(principal.orgId).get(row.role_id) ?? row.role_id;
		this.#notify({
			key: `iam:access-denied:${row.id}`,
			title: `Access denied: ${roleName} at ${scopeLabel(scope)}`,
			detail:
				`${principal.userId} denied ${row.requester_id}'s request for ${roleName} at ${scopeLabel(scope)}. ` +
				`Reason given: ${row.reason}`,
			severity: 'warning',
			url: this.#url(`/iam/access/${row.id}`),
			recipients: this.#emailsFor(principal.orgId, [row.requester_id]),
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

	// ---------------------------------------------------------------- permission usage

	/**
	 * Recompute each org's permission usage from `audit_log` (IAM.md I23, §9.5). The sweep calls
	 * this daily.
	 *
	 * `audit_log` has no permission column, so the permission is derived from `action` (see
	 * `permissionFromAction`). Rows whose action cannot be mapped are skipped, as are rows with no
	 * `actor_id`. Audit rows carry no scope either, so every row is recorded at org scope: the
	 * table's `scope_type`/`scope_id` are placeholders until audit learns to carry a resource.
	 *
	 * The org's rows are deleted and reinserted inside one transaction. That makes a second run on
	 * the same day idempotent, makes counts correct after a late audit row, and drops rows that have
	 * aged out of the 30-day window. `last_used_at` is therefore only as old as the window.
	 */
	rollupUsage(): UsageRollupResult {
		const to = this.ctx.now();
		const from = to - USAGE_WINDOW_MS;
		const auditRows = this.#sqlite
			.query<AuditUsageRow, [number, number]>(
				`SELECT org_id, actor_type, actor_id, action, created_at
				FROM audit_log
				WHERE org_id IS NOT NULL AND created_at >= ? AND created_at <= ?`,
			)
			.all(from, to);

		const aggregate = new Map<
			string,
			{
				orgId: string;
				principalType: string;
				principalId: string;
				permission: string;
				lastUsedAt: number;
				count: number;
			}
		>();
		const orgs = new Set(
			this.#sqlite
				.query<{ org_id: string }, []>(
					'SELECT DISTINCT org_id FROM iam_permission_usage',
				)
				.all()
				.map((row) => row.org_id),
		);

		for (const row of auditRows) {
			const principalType = usagePrincipalType(row.actor_type);
			if (!principalType || !row.actor_id) continue;
			const permission = permissionFromAction(row.action);
			if (!permission) continue;
			orgs.add(row.org_id);
			const key = `${row.org_id}\u0000${principalType}\u0000${row.actor_id}\u0000${permission}`;
			const entry = aggregate.get(key);
			if (entry) {
				entry.count += 1;
				entry.lastUsedAt = Math.max(entry.lastUsedAt, row.created_at);
			} else {
				aggregate.set(key, {
					orgId: row.org_id,
					principalType,
					principalId: row.actor_id,
					permission,
					lastUsedAt: row.created_at,
					count: 1,
				});
			}
		}

		this.#sqlite.transaction(() => {
			for (const orgId of orgs)
				this.#sqlite.run('DELETE FROM iam_permission_usage WHERE org_id = ?', [
					orgId,
				]);
			for (const entry of aggregate.values())
				this.#sqlite.run(
					`INSERT INTO iam_permission_usage
						(org_id, principal_type, principal_id, permission, scope_type, scope_id, last_used_at, count_30d)
					VALUES (?, ?, ?, ?, 'org', NULL, ?, ?)`,
					[
						entry.orgId,
						entry.principalType,
						entry.principalId,
						entry.permission,
						entry.lastUsedAt,
						entry.count,
					],
				);
		})();

		return { orgs: orgs.size, rows: aggregate.size, from, to };
	}

	/**
	 * The org's rolled-up usage, newest first (IAM.md §9.5). Reading someone else's usage needs
	 * `iam:read`; a principal may always read their own.
	 */
	usageFor(
		principal: Principal,
		options: { principalId?: string } = {},
	): PermissionUsageView[] {
		const principalId = options.principalId?.trim() || principal.userId;
		if (principalId !== principal.userId)
			this.ctx.iam.require(principal, 'iam:read', { type: 'org' });

		const rows = principalId
			? this.#sqlite
					.query<PermissionUsageRow, [string, string]>(
						`SELECT * FROM iam_permission_usage
						WHERE org_id = ? AND principal_id = ?
						ORDER BY last_used_at DESC`,
					)
					.all(principal.orgId, principalId)
			: this.#sqlite
					.query<PermissionUsageRow, [string]>(
						`SELECT * FROM iam_permission_usage
						WHERE org_id = ?
						ORDER BY last_used_at DESC`,
					)
					.all(principal.orgId);

		return rows.map((row) => ({
			principalType: row.principal_type,
			principalId: row.principal_id,
			permission: row.permission,
			scopeType: row.scope_type,
			scopeId: row.scope_id,
			lastUsedAt: row.last_used_at,
			count30d: row.count_30d,
		}));
	}

	/**
	 * Expire every pending request past the 24-hour TTL (IAM.md §9.4). The read path expires the
	 * caller's org on demand; this is the daily backstop, so an untouched org is still cleaned up.
	 * Returns the number of rows changed, so the maintenance report can show it.
	 */
	expireStaleRequests(now = this.ctx.now()): number {
		return this.#sqlite.run(
			`UPDATE access_requests SET status = 'expired'
			 WHERE status = 'pending' AND created_at <= ?`,
			[now - REQUEST_TTL_MS],
		).changes;
	}

	/**
	 * Complete every open campaign whose deadline has passed, applying its default decision to
	 * items nobody decided (IAM.md §9.5). Runs as an in-process system actor that holds only
	 * `iam:review` and `iam:manage-bindings`; a failure is logged and the campaign stays open for
	 * the next sweep rather than being half-applied.
	 */
	sweepOverdueReviews(now = this.ctx.now()): AccessReviewSweep {
		const reviews = this.#sqlite
			.query<AccessReviewRow, [number]>(
				`SELECT * FROM access_reviews
				 WHERE status = 'open' AND due_at IS NOT NULL AND due_at <= ?
				 ORDER BY due_at, id`,
			)
			.all(now);
		let completed = 0;
		for (const review of reviews) {
			const scope = scopeFromRow(review);
			if (!scope) continue;
			const reviewer =
				this.#sqlite
					.query<{ reviewer_id: string | null }, [string]>(
						`SELECT reviewer_id FROM access_review_items
						 WHERE review_id = ? AND reviewer_id IS NOT NULL ORDER BY created_at, id LIMIT 1`,
					)
					.get(review.id)?.reviewer_id ?? review.created_by;
			try {
				this.completeReview(maintenancePrincipal(review.org_id), review.id);
				completed += 1;
				this.#notify({
					key: `iam:review-overdue:${review.id}:${review.due_at}`,
					title: `Access review overdue: ${review.name}`,
					detail:
						`"${review.name}" at ${scopeLabel(scope)} passed its deadline (${formatTime(review.due_at ?? now)}). ` +
						`It was completed automatically; undecided items took the ${review.default_decision} default. ` +
						`Reviewer: ${reviewer}.`,
					severity: review.default_decision === 'revoke' ? 'warning' : 'info',
					url: this.#url(`/iam/reviews/${review.id}`),
					recipients: this.#emailsFor(review.org_id, [reviewer]),
				});
			} catch (error) {
				console.error(`[maintenance] access review ${review.id} could not be completed:`, error);
			}
		}
		return { flagged: reviews.length, completed };
	}

	/**
	 * Enabled service accounts with no use for the 90-day window (IAM.md §9.5). The usage data is
	 * `access_keys.last_used_at`; a never-used account is measured from creation, so a new account
	 * is not flagged. Reading needs `iam:read` or `serviceAccount:read`.
	 */
	unusedServiceAccounts(
		principal: Principal,
		options: { minDays?: number } = {},
	): UnusedServiceAccountView[] {
		if (
			!this.ctx.iam.can(principal, 'iam:read', { type: 'org' }) &&
			!principal.permissions.has('serviceAccount:read')
		)
			throw new ForbiddenError('iam:read');
		const minDays = options.minDays ?? SERVICE_ACCOUNT_UNUSED_DAYS;
		return this.ctx.serviceAccounts
			.sweepUnused(principal.orgId, { now: this.ctx.now(), minDays })
			.unused.map((account) => ({
				id: account.id,
				name: account.name,
				ownerGroupId: account.ownerGroupId,
				disabled: account.disabled,
				createdAt: account.createdAt,
				lastUsedAt: account.lastUsedAt,
				unusedDays: account.unusedDays,
			}));
	}

	// ---------------------------------------------------------------- access reviews

	/**
	 * The org's access-review campaigns, newest first (IAM.md I23, §9.5). Visible with `iam:read`;
	 * starting, deciding and completing need `iam:review`.
	 */
	listReviews(
		principal: Principal,
		options: AccessReviewListOptions = {},
	): AccessReviewView[] {
		// Reading is `iam:read`, but a reviewer granted only `iam:review` still needs their queue.
		if (
			!this.ctx.iam.can(principal, 'iam:read', { type: 'org' }) &&
			!this.ctx.iam.can(principal, 'iam:review', { type: 'org' })
		)
			throw new ForbiddenError('iam:read');
		const reviews = this.#sqlite
			.query<AccessReviewRow, [string]>(
				'SELECT * FROM access_reviews WHERE org_id = ? ORDER BY created_at DESC',
			)
			.all(principal.orgId);
		const items = this.#sqlite
			.query<AccessReviewItemRow, [string]>(
				'SELECT * FROM access_review_items WHERE org_id = ? ORDER BY created_at, id',
			)
			.all(principal.orgId);
		const byReview = new Map<string, AccessReviewItemRow[]>();
		for (const item of items) {
			const list = byReview.get(item.review_id) ?? [];
			list.push(item);
			byReview.set(item.review_id, list);
		}

		const rolePermissions = new Map(
			this.ctx.iam
				.listRoles(principal.orgId)
				.map((role) => [role.id, role.permissions] as const),
		);
		const usage = this.#lastUsedByPrincipal(principal.orgId);

		return reviews.flatMap((review) => {
			if (options.status && review.status !== options.status) return [];
			const scope = scopeFromRow(review);
			if (!scope) return [];
			return [
				this.#reviewView(
					review,
					scope,
					byReview.get(review.id) ?? [],
					rolePermissions,
					usage,
					principal,
				),
			];
		});
	}

	/**
	 * Start a campaign: snapshot every live binding at the scope (or, at org scope, every live
	 * binding in the org) into items and assign each to a manager of that scope. A project campaign
	 * includes bindings in its environments and on its resources.
	 */
	startReview(
		principal: Principal,
		input: AccessReviewCreate,
	): AccessReviewView {
		const scope = validateRequestScope(input.scope);
		this.ctx.iam.require(principal, 'iam:review', resourceForScope(scope));

		const now = this.ctx.now();
		const name = validateReviewName(input.name, now);
		const defaultDecision = input.defaultDecision ?? 'keep';
		if (defaultDecision !== 'keep' && defaultDecision !== 'revoke')
			throw new ValidationError('A review default is "keep" or "revoke".');
		if (
			input.dueAt !== undefined &&
			(!Number.isInteger(input.dueAt) || input.dueAt <= now)
		)
			throw new ValidationError(
				'A review deadline must be a future epoch-millisecond time.',
			);

		const reviewer = this.#reviewManager(principal, scope);
		const roles = new Map(
			this.ctx.iam
				.listRoles(principal.orgId)
				.map((role) => [role.id, role.name]),
		);
		const scoped = scopeToRow(scope);
		const bindings = this.#snapshotBindings(principal.orgId, scope, now);

		const id = newId('rev_');
		this.#sqlite.transaction(() => {
			this.#sqlite.run(
				`INSERT INTO access_reviews
					(id, org_id, name, scope_type, scope_id, scope_parent_id, status, default_decision,
						due_at, created_by, created_at, completed_by, completed_at)
				VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL, NULL)`,
				[
					id,
					principal.orgId,
					name,
					scoped.type,
					scoped.id,
					scoped.parentId,
					defaultDecision,
					input.dueAt ?? null,
					principal.userId,
					now,
				],
			);
			for (const binding of bindings) {
				const itemScope = scopeToRowForBinding(binding);
				this.#sqlite.run(
					`INSERT INTO access_review_items
						(id, review_id, org_id, binding_id, principal_type, principal_id, role_id, role_name,
							scope_type, scope_id, scope_parent_id, condition_json, expires_at, reviewer_id,
							decision, decided_by, decided_at, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
					[
						newId('rvi_'),
						id,
						principal.orgId,
						binding.id,
						binding.principal_type,
						binding.principal_id,
						binding.role_id,
						roles.get(binding.role_id) ?? binding.role_id,
						itemScope.type,
						itemScope.id,
						itemScope.parentId,
						binding.condition_json,
						binding.expires_at,
						reviewer,
						now,
					],
				);
			}
		})();

		this.ctx.audit.record({
			principal,
			action: 'iam.review.create',
			resource: 'access_review',
			resourceId: id,
			args: {
				name,
				scope,
				defaultDecision,
				dueAt: input.dueAt ?? null,
				items: bindings.length,
			},
			result: 'ok',
		});
		this.#notify({
			key: `iam:review-started:${id}`,
			title: `Access review started: ${name}`,
			detail:
				`${principal.userId} started "${name}" at ${scopeLabel(scope)} covering ${bindings.length} binding(s). ` +
				`Reviewer: ${reviewer}.` +
				(input.dueAt === undefined ? '' : ` Due ${formatTime(input.dueAt)}.`),
			severity: 'info',
			url: this.#url(`/iam/reviews/${id}`),
			recipients: this.#emailsFor(principal.orgId, [reviewer]),
		});
		return this.#reviewFor(principal, id);
	}

	/** Record `keep`, `revoke` or `shorten` for one item of an open campaign. */
	decideReviewItem(
		principal: Principal,
		id: string,
		decision: ReviewDecision,
	): AccessReviewItemView {
		if (decision !== 'keep' && decision !== 'revoke' && decision !== 'shorten')
			throw new ValidationError(
				'A review decision is "keep", "revoke" or "shorten".',
			);
		const item = this.#reviewItemRow(principal.orgId, id);
		if (!item) throw new NotFoundError('Access review item');
		const review = this.#reviewRow(principal.orgId, item.review_id);
		if (!review) throw new NotFoundError('Access review');
		if (review.status !== 'open')
			throw new ConflictError('This access review has already been completed.');
		const scope = scopeFromRow(review);
		if (!scope) throw new ValidationError('That review has an invalid scope.');
		this.ctx.iam.require(principal, 'iam:review', resourceForScope(scope));

		const now = this.ctx.now();
		this.#sqlite.run(
			`UPDATE access_review_items
			SET decision = ?, decided_by = ?, decided_at = ?
			WHERE id = ? AND org_id = ?`,
			[decision, principal.userId, now, item.id, principal.orgId],
		);
		this.ctx.audit.record({
			principal,
			action: 'iam.review.decide',
			resource: 'access_review_item',
			resourceId: item.id,
			args: {
				reviewId: review.id,
				bindingId: item.binding_id,
				decision,
				principalType: item.principal_type,
				principalId: item.principal_id,
				roleId: item.role_id,
			},
			result: 'ok',
		});
		return this.#reviewItemView(
			{ ...item, decision, decided_by: principal.userId, decided_at: now },
			now,
		);
	}

	/**
	 * Close a campaign and apply its decisions. `keep` does nothing, `revoke` deletes the binding
	 * through `iam.unbind`, and `shorten` caps its `expires_at` at {@link REVIEW_SHORTEN_DAYS}
	 * (never extending an expiry that is already sooner). Undecided items take the campaign's
	 * default. A binding deleted since the snapshot is skipped.
	 */
	completeReview(principal: Principal, id: string): AccessReviewView {
		const review = this.#reviewRow(principal.orgId, id);
		if (!review) throw new NotFoundError('Access review');
		if (review.status !== 'open')
			throw new ConflictError('This access review has already been completed.');
		const scope = scopeFromRow(review);
		if (!scope) throw new ValidationError('That review has an invalid scope.');
		const resource = resourceForScope(scope);
		this.ctx.iam.require(principal, 'iam:review', resource);

		const items = this.#sqlite
			.query<AccessReviewItemRow, [string, string]>(
				'SELECT * FROM access_review_items WHERE review_id = ? AND org_id = ? ORDER BY created_at, id',
			)
			.all(id, principal.orgId);
		const effective = items.map((item) => ({
			item,
			decision: (item.decision ?? review.default_decision) as ReviewDecision,
		}));
		// Revoking goes through `iam.unbind`, which needs `iam:manage-bindings` too. Check that
		// before touching anything so a review cannot fail halfway and leave some items applied.
		if (effective.some((entry) => entry.decision === 'revoke'))
			this.ctx.iam.require(principal, 'iam:manage-bindings', resource);

		const now = this.ctx.now();
		const shortenTo = now + REVIEW_SHORTEN_MS;
		const counts = { kept: 0, revoked: 0, shortened: 0 };
		for (const { item, decision } of effective) {
			const binding = this.#sqlite
				.query<{ id: string; expires_at: number | null }, [string, string]>(
					'SELECT id, expires_at FROM iam_bindings WHERE id = ? AND org_id = ?',
				)
				.get(item.binding_id, principal.orgId);

			if (decision === 'keep') {
				counts.kept += 1;
			} else if (decision === 'revoke') {
				if (binding) this.ctx.iam.unbind(principal, item.binding_id);
				counts.revoked += 1;
			} else {
				if (binding) {
					const expiresAt =
						binding.expires_at === null
							? shortenTo
							: Math.min(binding.expires_at, shortenTo);
					this.#sqlite.transaction(() => {
						this.#sqlite.run(
							'UPDATE iam_bindings SET expires_at = ? WHERE id = ?',
							[expiresAt, binding.id],
						);
						this.ctx.iam.touch(principal.orgId);
					})();
				}
				counts.shortened += 1;
			}
		}

		this.#sqlite.transaction(() => {
			for (const { item, decision } of effective) {
				if (item.decision !== null) continue;
				this.#sqlite.run(
					`UPDATE access_review_items
					SET decision = ?, decided_by = 'system:review-default', decided_at = ?
					WHERE id = ? AND decision IS NULL`,
					[decision, now, item.id],
				);
			}
			this.#sqlite.run(
				`UPDATE access_reviews
				SET status = 'completed', completed_by = ?, completed_at = ?
				WHERE id = ? AND status = 'open'`,
				[principal.userId, now, id],
			);
		})();

		this.ctx.audit.record({
			principal,
			action: 'iam.review.complete',
			resource: 'access_review',
			resourceId: id,
			args: { scope, items: items.length, ...counts },
			result: 'ok',
		});
		return this.#reviewFor(principal, id);
	}

	// ------------------------------------------------------------------------- internals

	/**
	 * JIT and review messages go through the platform's configured channels (email/webhook/chat)
	 * as plain `AlertMessage`s. Nothing here is a system alert, nothing is stored in alert history,
	 * and the payload never includes a key, token or hash.
	 */
	#notify(notification: IamNotification): void {
		void notifyIam(this.ctx.notifiers, notification).catch((error: unknown) =>
			console.error('[iam] notification failed:', error),
		);
	}

	#url(path: string): string {
		return `${this.ctx.config.platformOrigin.replace(/\/$/, '')}${path}`;
	}

	/** A human hint in the request notification; the approvers stay the authorization decision. */
	#approversLine(orgId: string, scope: ScopeRef, requesterId: string): string {
		const unique = this.#approverIds(orgId, scope, requesterId);
		if (unique === null) return 'Approvers could not be listed.';
		return unique.length > 0
			? `Approvers: ${unique.join(', ')}`
			: 'No approver currently holds iam:manage-bindings at this scope.';
	}

	/** User ids that may decide at this scope, excluding the requester. Null when unavailable. */
	#approverIds(orgId: string, scope: ScopeRef, requesterId: string): string[] | null {
		try {
			const approvers = this.ctx.iam
				.whoCan(orgId, 'iam:manage-bindings', resourceForScope(scope))
				.filter((entry) => entry.principalType === 'user' && entry.principalId !== requesterId)
				.map((entry) => entry.principalId);
			return [...new Set(approvers)];
		} catch {
			return null;
		}
	}

	/**
	 * Email addresses for user ids, looked up through Better Auth's `user` table and filtered to
	 * members of this organisation when its `member` table exists. Notifications are best-effort:
	 * a missing table or address simply yields fewer recipients and falls back to the configured
	 * channels. Addresses are used only for delivery, never written to the audit log.
	 */
	#emailsFor(orgId: string, userIds: readonly string[]): string[] {
		const ids = [
			...new Set(
				userIds
					.map((id) => id.trim())
					.filter(
						(id) =>
							id.length > 0 &&
							!id.startsWith('system:') &&
							!id.startsWith('service:') &&
							!id.startsWith('sa_'),
					),
			),
		];
		if (ids.length === 0) return [];
		const placeholders = ids.map(() => '?').join(',');
		let rows: Array<{ email: string | null }> = [];
		try {
			rows = this.#sqlite
				.query<{ email: string | null }, string[]>(
					`SELECT u.email AS email
					 FROM "user" u
					 JOIN member m ON m.userId = u.id
					 WHERE m.organizationId = ? AND u.id IN (${placeholders})`,
				)
				.all(orgId, ...ids);
		} catch {
			try {
				rows = this.#sqlite
					.query<{ email: string | null }, string[]>(
						`SELECT email FROM "user" WHERE id IN (${placeholders})`,
					)
					.all(...ids);
			} catch {
				return [];
			}
		}
		const out: string[] = [];
		for (const row of rows) {
			const email = row.email?.trim().toLowerCase() ?? '';
			if (!email || !email.includes('@') || /[\r\n\0]/.test(email)) continue;
			if (!out.includes(email)) out.push(email);
		}
		return out;
	}

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

	// ------------------------------------------------------------------- review internals

	#reviewRow(orgId: string, id: string): AccessReviewRow | undefined {
		return (
			this.#sqlite
				.query<AccessReviewRow, [string, string]>(
					'SELECT * FROM access_reviews WHERE id = ? AND org_id = ?',
				)
				.get(id, orgId) ?? undefined
		);
	}

	#reviewItemRow(orgId: string, id: string): AccessReviewItemRow | undefined {
		return (
			this.#sqlite
				.query<AccessReviewItemRow, [string, string]>(
					'SELECT * FROM access_review_items WHERE id = ? AND org_id = ?',
				)
				.get(id, orgId) ?? undefined
		);
	}

	#reviewFor(principal: Principal, id: string): AccessReviewView {
		const review = this.#reviewRow(principal.orgId, id);
		if (!review) throw new NotFoundError('Access review');
		const scope = scopeFromRow(review);
		if (!scope) throw new ValidationError('That review has an invalid scope.');
		const items = this.#sqlite
			.query<AccessReviewItemRow, [string]>(
				'SELECT * FROM access_review_items WHERE review_id = ? ORDER BY created_at, id',
			)
			.all(id);
		const rolePermissions = new Map(
			this.ctx.iam
				.listRoles(principal.orgId)
				.map((role) => [role.id, role.permissions] as const),
		);
		return this.#reviewView(
			review,
			scope,
			items,
			rolePermissions,
			this.#lastUsedByPrincipal(principal.orgId),
			principal,
		);
	}

	#reviewView(
		review: AccessReviewRow,
		scope: ScopeRef,
		items: readonly AccessReviewItemRow[],
		rolePermissions: ReadonlyMap<string, readonly Permission[]>,
		usage: ReadonlyMap<string, number>,
		principal: Principal,
	): AccessReviewView {
		const now = this.ctx.now();
		const viewItems = items.flatMap((item) =>
			scopeFromRow(item)
				? [
						this.#reviewItemView(
							item,
							now,
							rolePermissions.get(item.role_id),
							usage,
						),
					]
				: [],
		);
		return {
			id: review.id,
			name: review.name,
			scope,
			status: review.status as ReviewStatus,
			defaultDecision: review.default_decision as ReviewDefaultDecision,
			dueAt: review.due_at,
			createdBy: review.created_by,
			createdAt: review.created_at,
			completedBy: review.completed_by,
			completedAt: review.completed_at,
			items: viewItems,
			canDecide:
				review.status === 'open' &&
				this.ctx.iam.can(principal, 'iam:review', resourceForScope(scope)),
			assignedToMe:
				review.status === 'open'
					? items.filter(
							(item) =>
								item.reviewer_id === principal.userId && item.decision === null,
						).length
					: 0,
			overdue:
				review.status === 'open' &&
				review.due_at !== null &&
				review.due_at <= now,
		};
	}

	#reviewItemView(
		row: AccessReviewItemRow,
		now: number,
		rolePermissions?: readonly Permission[],
		usage?: ReadonlyMap<string, number>,
	): AccessReviewItemView {
		let lastUsedAt: number | null = null;
		if (usage && rolePermissions) {
			for (const permission of rolePermissions) {
				const used = usage.get(
					usageKey(row.principal_type, row.principal_id, permission),
				);
				if (used !== undefined && (lastUsedAt === null || used > lastUsedAt))
					lastUsedAt = used;
			}
		}
		return {
			id: row.id,
			reviewId: row.review_id,
			bindingId: row.binding_id,
			principalType: row.principal_type,
			principalId: row.principal_id,
			roleId: row.role_id,
			roleName: row.role_name || row.role_id,
			scope: scopeFromRow(row) ?? { type: 'org' },
			condition: parseCondition(row.condition_json),
			expiresAt: row.expires_at,
			reviewerId: row.reviewer_id,
			decision: (row.decision as ReviewDecision | null) ?? null,
			decidedBy: row.decided_by,
			decidedAt: row.decided_at,
			lastUsedAt,
			unusedDays:
				lastUsedAt === null
					? null
					: Math.max(0, Math.floor((now - lastUsedAt) / 86_400_000)),
		};
	}

	/**
	 * The live bindings a campaign covers. An org campaign covers the whole org; a project campaign
	 * covers the project, its environments and its resources; anything narrower matches exactly.
	 */
	#snapshotBindings(
		orgId: string,
		scope: ScopeRef,
		now: number,
	): BindingSnapshotRow[] {
		const unexpired = '(expires_at IS NULL OR expires_at > ?)';
		switch (scope.type) {
			case 'org':
				return this.#sqlite
					.query<BindingSnapshotRow, [string, number]>(
						`SELECT * FROM iam_bindings
						WHERE org_id = ? AND ${unexpired}
						ORDER BY created_at, id`,
					)
					.all(orgId, now);
			case 'project':
				return this.#sqlite
					.query<BindingSnapshotRow, [string, number, string, string]>(
						`SELECT * FROM iam_bindings
						WHERE org_id = ? AND ${unexpired}
							AND ((scope_type = 'project' AND scope_id = ?) OR scope_parent_id = ?)
						ORDER BY created_at, id`,
					)
					.all(orgId, now, scope.id, scope.id);
			case 'environment':
				return this.#sqlite
					.query<BindingSnapshotRow, [string, number, string]>(
						`SELECT * FROM iam_bindings
						WHERE org_id = ? AND ${unexpired}
							AND scope_type = 'environment' AND scope_id = ?
						ORDER BY created_at, id`,
					)
					.all(orgId, now, scope.id);
			case 'platform':
				// Reviews are for org resources; `startReview` rejects a platform scope.
				return [];
			default:
				return this.#sqlite
					.query<BindingSnapshotRow, [string, number, string, string]>(
						`SELECT * FROM iam_bindings
						WHERE org_id = ? AND ${unexpired}
							AND scope_type = ? AND scope_id = ?
						ORDER BY created_at, id`,
					)
					.all(orgId, now, scope.type, scope.id);
		}
	}

	/**
	 * A manager of the campaign's scope, as a hint for the item's reviewer. Prefers someone other
	 * than the person starting the campaign, then the caller.
	 */
	#reviewManager(principal: Principal, scope: ScopeRef): string {
		const managers = this.ctx.iam
			.whoCan(principal.orgId, 'iam:manage-bindings', resourceForScope(scope))
			.filter((entry) => entry.principalType === 'user')
			.map((entry) => entry.principalId)
			.sort();
		return (
			managers.find((id) => id !== principal.userId) ??
			managers[0] ??
			principal.userId
		);
	}

	/** Newest use per `(principal_type, principal_id, permission)` in the org's usage rows. */
	#lastUsedByPrincipal(orgId: string): Map<string, number> {
		const out = new Map<string, number>();
		try {
			const rows = this.#sqlite
				.query<
					{
						principal_type: string;
						principal_id: string;
						permission: string;
						last_used_at: number;
					},
					[string]
				>(
					`SELECT principal_type, principal_id, permission, MAX(last_used_at) AS last_used_at
					FROM iam_permission_usage
					WHERE org_id = ?
					GROUP BY principal_type, principal_id, permission`,
				)
				.all(orgId);
			for (const row of rows)
				out.set(
					usageKey(row.principal_type, row.principal_id, row.permission),
					row.last_used_at,
				);
		} catch {
			// The usage table may not exist on an upgrading install; the hint is optional.
		}
		return out;
	}
}

// ------------------------------------------------------------------- usage derivation

/**
 * Audit actions whose permission is not the obvious `resource:verb` pair. The audit log records
 * what happened, not which permission was checked, so this table (and the fallback below) is a
 * best-effort derivation. An action that does not map is skipped rather than guessed: a wrong
 * 'last used' is worse than a missing one.
 */
const ACTION_PERMISSION: Readonly<Record<string, Permission>> = {
	'database.credentials': 'database:credentials',
	'database.credentials.reveal': 'database:credentials',
	'database.credential.create': 'database:credentials',
	'database.credential.revoke': 'database:credentials',
	'database.credential.rotate': 'database:credentials',
	'database.console.open': 'database:console',
	'database.studio.run': 'database:console',
	'database.studio.write': 'database:console',
	'database.studio.alter': 'database:console',
	'database.studio.principal-requested': 'database:console',
	'database.restore': 'database:update',
	'database.restore-backup': 'database:update',
	'database.pitr-restore': 'database:update',
	'database.rotate': 'database:update',
	'broker.credentials': 'broker:credentials',
	'storage.credentials': 'storage:credentials',
	'storage.key.create': 'storage:credentials',
	'storage.key.reveal': 'storage:credentials',
	'storage.key.revoke': 'storage:credentials',
	'storage.root-key.rotate': 'storage:credentials',
	'storage.root-key.rollback': 'storage:credentials',
	'storage.root-key.cancel': 'storage:credentials',
	'email.credential.create': 'email:credentials',
	'email.credential.revoke': 'email:credentials',
	'org.rename': 'org:update',
	'project.set_access': 'project:update',
	'environment.set_access': 'environment:update',
	'member.update_role': 'member:update-role',
	'member.cancel_invitation': 'member:invite',
	'iam.binding.create': 'iam:manage-bindings',
	'iam.binding.delete': 'iam:manage-bindings',
	'iam.role.create': 'iam:manage-roles',
	'iam.role.delete': 'iam:manage-roles',
	'iam.group.create': 'iam:manage-groups',
	'iam.group.member.add': 'iam:manage-groups',
	'iam.guardrail.create': 'iam:manage-guardrails',
	'iam.guardrail.update': 'iam:manage-guardrails',
	'iam.guardrail.delete': 'iam:manage-guardrails',
	'iam.review.create': 'iam:review',
	'iam.review.decide': 'iam:review',
	'iam.review.complete': 'iam:review',
	'iam.key.rotate': 'iam:read',
	'iam.token.exchange': 'iam:read',
	'service_account.create': 'serviceAccount:create',
	'service_account.update': 'serviceAccount:update',
	'service_account.delete': 'serviceAccount:delete',
	'access_key.create': 'accessKey:create',
	'access_key.revoke': 'accessKey:revoke',
	'share_link.create': 'shareLink:create',
	'share_link.revoke': 'shareLink:revoke',
	'share_link.read': 'shareLink:read',
	'share.credential.use': 'shareLink:read',
};

/** Audit resource nouns that differ from a catalog resource name. */
const RESOURCE_ALIASES: Readonly<Record<string, string>> = {
	alert_rule: 'alert',
	alert_silence: 'alert',
	access_key: 'accessKey',
	service_account: 'serviceAccount',
	share_link: 'shareLink',
	share: 'shareLink',
	log_drain: 'logDrain',
	app_volume: 'volume',
};

/** Derive the catalog permission an audit row most likely exercised (see `ACTION_PERMISSION`). */
export function permissionFromAction(action: string): Permission | null {
	const override = ACTION_PERMISSION[action];
	if (override) return override;
	const parts = action.split('.').filter(Boolean);
	if (parts.length < 2) return null;
	const head = parts[0]!;
	const resource = RESOURCE_ALIASES[head] ?? head;
	if (!(resource in statements)) return null;
	// Prefer the most specific verb (`storage.bucket.create` → `storage:create`), then broader
	// segments. A compound action such as `database.public-url.reveal` maps to `database:reveal`
	// only if the catalog has it; otherwise it is skipped.
	for (const segment of [...parts.slice(1)].reverse()) {
		const candidate = `${resource}:${segment.replaceAll('_', '-')}`;
		if (isPermission(candidate)) return candidate;
	}
	return null;
}

/** `audit_log.actor_type` → the usage table's principal type. Null skips the row. */
function usagePrincipalType(
	actorType: string,
): 'user' | 'serviceAccount' | null {
	switch (actorType) {
		case 'user':
		case 'apiKey':
		case 'mcp':
		case 'agent':
			return 'user';
		case 'system':
			// IAM.md §7.1: service accounts are written as `system` until the audit CHECK is relaxed.
			return 'serviceAccount';
		default:
			return null;
	}
}

function usageKey(
	principalType: string,
	principalId: string,
	permission: string,
): string {
	return `${principalType}\u0000${principalId}\u0000${permission}`;
}

function scopeToRowForBinding(binding: {
	scope_type: string;
	scope_id: string | null;
	scope_parent_id: string | null;
}): { type: string; id: string | null; parentId: string | null } {
	return {
		type: binding.scope_type,
		id: binding.scope_id,
		parentId: binding.scope_parent_id,
	};
}

function validateReviewName(raw: string | undefined, now: number): string {
	const name =
		(raw ?? '').trim() ||
		`Access review · ${new Date(now).toISOString().slice(0, 10)}`;
	if (name.length < 2 || name.length > 80)
		throw new ValidationError('A review name is 2–80 characters.');
	if (/[\r\n\t]/.test(name))
		throw new ValidationError('A review name must be a single line of text.');
	return name;
}

// ------------------------------------------------------------------------ scope helpers

/** The daily sweep's in-process actor; only the two writes a review completion needs. */
function maintenancePrincipal(orgId: string): Principal {
	return {
		kind: 'system',
		userId: 'system:iam-maintenance',
		orgId,
		role: 'viewer',
		permissions: new Set<Permission>(['iam:review', 'iam:manage-bindings']),
		credential: 'system',
	};
}

function scopeLabel(scope: ScopeRef): string {
	switch (scope.type) {
		case 'platform':
			return 'the platform';
		case 'org':
			return 'the organisation';
		case 'project':
			return `project ${scope.id}`;
		case 'environment':
			return `environment ${scope.id}`;
		default:
			return `${scope.type} ${scope.id}`;
	}
}

function formatDuration(seconds: number): string {
	if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
	const hours = seconds / 3600;
	return Number.isInteger(hours) ? `${hours} h` : `${hours.toFixed(1)} h`;
}

function formatTime(ms: number): string {
	return new Date(ms).toISOString();
}

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


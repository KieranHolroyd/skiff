/**
 * Yoal Access policies (IAM.md I25, §11.1).
 *
 * The pure decision lives in `@yoal/contracts` (`evaluateAccessPolicy`). This service stores the
 * policies, resolves the policy a content host uses, and writes the assignment a project or
 * environment points at. It reuses the IAM engine for permissions: `accessPolicy:create|read|
 * update|delete`, attachable at org, project and environment scope through the existing
 * `accessPolicy` resource type in the catalog — no engine change was needed.
 */
import type { Database } from 'bun:sqlite';
import {
	accessPolicyMatcherSchema,
	accessPolicyRuleSchema,
	accessServiceTokenCreateSchema,
	evaluateAccessPolicy,
	serviceTokenRules,
	type AccessIdentity,
	type AccessPolicy,
	type AccessPolicyDecision,
	type AccessPolicyRule,
	type AccessPolicyScope,
	type AccessPolicyUpdate,
	type AccessServiceToken,
	type AccessServiceTokenCreate,
	type AccessServiceTokenRule,
	type Principal,
	type ResourceRef,
} from '@yoal/contracts';
import type { CoreContext } from '../context.ts';
import type { ContentRoute } from '../access.ts';
import { NotFoundError, ValidationError } from '../errors.ts';
import { newId, randomToken, sha256Hex } from '../util.ts';
import type { ProjectRow } from '../projects.ts';

/** Last-used updates are deliberately coarse: an agent may report every request. */
export const SERVICE_TOKEN_TOUCH_INTERVAL_MS = 60_000;

interface PolicyRow {
	id: string;
	org_id: string;
	name: string;
	description: string;
	scope_type: string;
	scope_id: string | null;
	scope_parent_id: string | null;
	enabled: number;
	/** Bumped on a revocation; zero falls back to the project's site epoch. */
	version: number;
	created_by: string;
	created_at: number;
	updated_at: number;
}

interface RuleRow {
	idx: number;
	action: string;
	matcher_json: string;
}

interface ServiceTokenRow {
	id: string;
	org_id: string;
	policy_id: string;
	name: string;
	header: string;
	token_hash: string;
	created_by: string;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
}

export interface CreatedServiceToken {
	token: AccessServiceToken;
	/** The raw `yoal_svc_…` value. Returned once and never stored. */
	secret: string;
}

export interface AccessPolicyView extends AccessPolicy {
	/** Bumped on a revocation; zero means the host still uses its project's site epoch. */
	version: number;
}

export interface AccessPolicyAssignInput {
	/** `production` or `previews` on the project, or one named environment id. */
	scope: 'production' | 'previews' | 'environment';
	environmentId?: string;
	/** `null` turns Yoal Access off for the scope. */
	policyId: string | null;
}

export interface HostPolicy {
	policy: AccessPolicy;
	route: ContentRoute;
}

export class AccessPolicyService {
	readonly #sqlite: Database;

	constructor(private readonly ctx: CoreContext) {
		this.#sqlite = ctx.sqlite;
	}

	// ---------------------------------------------------------------- reads

	list(principal: Principal, options: { projectId?: string } = {}): AccessPolicyView[] {
		const rows = this.#sqlite
			.query<PolicyRow, [string]>(
				'SELECT * FROM access_policies WHERE org_id = ? ORDER BY name COLLATE NOCASE',
			)
			.all(principal.orgId);
		return rows
			.filter(
				(row) =>
					!options.projectId ||
					row.scope_type === 'org' ||
					row.scope_id === options.projectId ||
					row.scope_parent_id === options.projectId,
			)
			.filter((row) => this.ctx.iam.can(principal, 'accessPolicy:read', refFor(row)))
			.map((row) => this.view(row));
	}

	get(principal: Principal, id: string): AccessPolicyView {
		const row = this.requireRow(principal.orgId, id);
		this.ctx.iam.require(principal, 'accessPolicy:read', refFor(row));
		return this.view(row);
	}

	/** The policy a host uses, with the route it belongs to. Disabled policies are returned so the
	 * caller records the deny; an unassigned host returns null. */
	resolveForHost(host: string): HostPolicy | null {
		const route = this.ctx.access.resolveContentHost(host);
		if (!route || route.access !== 'access' || !route.policyId) return null;
		const row = this.#sqlite
			.query<PolicyRow, [string, string]>(
				'SELECT * FROM access_policies WHERE id = ? AND org_id = ?',
			)
			.get(route.policyId, route.project.orgId);
		if (!row) return null;
		return { policy: this.view(row), route };
	}

	/** Evaluate a host's policy for an identity. `login` means sign in on the platform first. */
	decide(
		host: string,
		identity: AccessIdentity,
		request: { ip?: string | null; headers?: Record<string, string | undefined> } = {},
	): { decision: AccessPolicyDecision; resolved: HostPolicy | null } {
		const resolved = this.resolveForHost(host);
		if (!resolved) return { decision: 'deny', resolved: null };
		return {
			decision: evaluateAccessPolicy(resolved.policy, identity, request),
			resolved,
		};
	}

	/**
	 * The part of a policy the edge needs (IAM.md I25): whether it is enabled, its service-token
	 * rules, and whether any rule could still match a person. Desired state carries this per route
	 * so the agent can allow a machine token before it redirects an anonymous browser.
	 */
	edgeSettings(policyId: string): {
		enabled: boolean;
		version: number;
		serviceTokens: AccessServiceTokenRule[];
		hasPersonRules: boolean;
	} {
		const row = this.#sqlite
			.query<{ enabled: number; version: number }, [string]>(
				'SELECT enabled, version FROM access_policies WHERE id = ?',
			)
			.get(policyId);
		if (!row) return { enabled: false, version: 0, serviceTokens: [], hasPersonRules: true };
		const rules = this.rules(policyId);
		return {
			enabled: row.enabled === 1,
			version: row.version ?? 0,
			// Named tokens from the database are merged with legacy `serviceToken` matchers still in
			// the policy JSON. DB tokens are allow-only; a legacy deny rule still wins in the
			// evaluator regardless of order. Revoked rows are excluded here and on the
			// `access_service_tokens` query, so a revocation disappears on the next desired-state pull.
			serviceTokens: [
				...serviceTokenRules({ rules }),
				...this.activeServiceTokenRules(policyId),
			],
			// Anything the agent cannot prove from headers alone (a person, a CIDR request, a pool)
			// means an anonymous visitor may still have a way in and should be sent to login.
			hasPersonRules: rules.some((rule) => rule.matcher.type !== 'serviceToken'),
		};
	}

	// ---------------------------------------------------------------- service tokens

	/**
	 * Named machine tokens for a policy. The raw value and its hash never leave `createServiceToken`;
	 * this view is what Settings and the API show (name, header, last-used, revocation state).
	 */
	listServiceTokens(principal: Principal, policyId: string): AccessServiceToken[] {
		const row = this.requireRow(principal.orgId, policyId);
		this.ctx.iam.require(principal, 'accessPolicy:read', refFor(row));
		return this.#sqlite
			.query<ServiceTokenRow, [string, string]>(
				`SELECT * FROM access_service_tokens
				 WHERE policy_id = ? AND org_id = ?
				 ORDER BY created_at DESC, id DESC`,
			)
			.all(policyId, principal.orgId)
			.map((token) => serviceTokenView(token));
	}

	/**
	 * Mint a named token. The secret is shown once; only its SHA-256 is stored, and the token is
	 * published to agents through `edgeSettings` on the next desired-state pull. Creating a token is
	 * not a revocation: it touches the policy's `updated_at` and the global desired-state watermark
	 * but does not bump the revocation version, so existing visitors stay signed in.
	 */
	createServiceToken(
		principal: Principal,
		policyId: string,
		input: AccessServiceTokenCreate,
	): CreatedServiceToken {
		const row = this.requireRow(principal.orgId, policyId);
		this.ctx.iam.require(principal, 'accessPolicy:update', refFor(row));
		const parsed = accessServiceTokenCreateSchema.parse(input);
		// Desired state publishes at most 100 service tokens per route (`routeAccessSchema`); keep
		// DB tokens within the same budget as legacy `serviceToken` rules.
		const active = this.#sqlite
			.query<{ count: number }, [string]>(
				'SELECT COUNT(*) AS count FROM access_service_tokens WHERE policy_id = ? AND revoked_at IS NULL',
			)
			.get(policyId)?.count ?? 0;
		const legacy = this.rules(policyId).filter((rule) => rule.matcher.type === 'serviceToken').length;
		if (active + legacy >= 100)
			throw new ValidationError('A policy may have at most 100 service tokens.');
		const secret = `yoal_svc_${randomToken(32)}`;
		const tokenHash = sha256Hex(secret);
		const id = newId('ast_');
		const now = this.ctx.now();
		this.#sqlite.run(
			`INSERT INTO access_service_tokens
			   (id, org_id, policy_id, name, header, token_hash, created_by, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[id, principal.orgId, policyId, parsed.name, parsed.header, tokenHash, principal.userId, now],
		);
		// The host's edge copy must learn the new hash; `projects.bump` changes the desired-state
		// watermark without rotating the policy's site key.
		this.#sqlite.run('UPDATE access_policies SET updated_at = ? WHERE id = ? AND org_id = ?', [
			now,
			policyId,
			principal.orgId,
		]);
		this.ctx.projects.bump(principal.orgId);
		this.ctx.audit.record({
			principal,
			action: 'access_policy.service_token.create',
			resource: 'access_policy',
			resourceId: policyId,
			args: { tokenId: id, name: parsed.name, header: parsed.header },
			result: 'ok',
		});
		return { token: serviceTokenView(this.requireServiceTokenRow(policyId, id)), secret };
	}

	/**
	 * Revoke a token: the row is kept for history, `revoked_at` is set, and the policy version is
	 * bumped. The version is folded into every host's site key, so browsers already signed in under
	 * this policy are signed out too. Revoking an already-revoked token is a no-op.
	 */
	revokeServiceToken(principal: Principal, policyId: string, tokenId: string): AccessServiceToken {
		const policy = this.requireRow(principal.orgId, policyId);
		this.ctx.iam.require(principal, 'accessPolicy:update', refFor(policy));
		const token = this.requireServiceTokenRow(policyId, tokenId);
		if (token.revoked_at === null) {
			const now = this.ctx.now();
			this.#sqlite.run(
				'UPDATE access_service_tokens SET revoked_at = ? WHERE id = ? AND policy_id = ? AND revoked_at IS NULL',
				[now, tokenId, policyId],
			);
			this.bumpPolicyVersion(policyId);
			this.ctx.projects.bump(principal.orgId);
			this.ctx.audit.record({
				principal,
				action: 'access_policy.service_token.revoke',
				resource: 'access_policy',
				resourceId: policyId,
				args: { tokenId, name: token.name, header: token.header },
				result: 'ok',
			});
		}
		return serviceTokenView(this.requireServiceTokenRow(policyId, tokenId));
	}

	/**
	 * Best-effort last-used reporting from the edge (no principal, no request-path writes). Returns
	 * true when the timestamp moved; a report within a minute of the last one is ignored. An unknown,
	 * revoked or unknown token is silently ignored so the endpoint is not an oracle.
	 */
	touchServiceToken(policyId: string, tokenHash: string, now = this.ctx.now()): boolean {
		const token = this.#sqlite
			.query<{ id: string; last_used_at: number | null }, [string, string]>(
				`SELECT id, last_used_at FROM access_service_tokens
				 WHERE policy_id = ? AND token_hash = ? AND revoked_at IS NULL`,
			)
			.get(policyId, tokenHash);
		if (!token) return false;
		if (token.last_used_at !== null && now - token.last_used_at < SERVICE_TOKEN_TOUCH_INTERVAL_MS)
			return false;
		this.#sqlite.run(
			'UPDATE access_service_tokens SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL',
			[now, token.id],
		);
		return true;
	}

	/** A policy's current revocation version; zero falls back to the project's site epoch. */
	versionOf(policyId: string): number {
		return (
			this.#sqlite
				.query<{ version: number }, [string]>(
					'SELECT version FROM access_policies WHERE id = ?',
				)
				.get(policyId)?.version ?? 0
		);
	}

	// ---------------------------------------------------------------- writes

	create(
		principal: Principal,
		input: {
			name: string;
			description?: string;
			scope: AccessPolicyScope;
			enabled?: boolean;
			rules: readonly AccessPolicyRule[];
		},
	): AccessPolicyView {
		const name = input.name.trim();
		if (!name) throw new ValidationError('Give the policy a name.');
		const scope = this.validateScope(principal, input.scope);
		this.ctx.iam.require(principal, 'accessPolicy:create', createRef(scope));
		const rules = normalizeRules(input.rules);
		const id = newId('apol_');
		const now = this.ctx.now();
		this.#sqlite.transaction(() => {
			this.#sqlite.run(
				`INSERT INTO access_policies
				   (id, org_id, name, description, scope_type, scope_id, scope_parent_id, enabled,
				    created_by, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					principal.orgId,
					name,
					input.description?.trim() ?? '',
					scope.type,
					scope.type === 'org' ? null : scope.id,
					scope.type === 'environment' ? scope.projectId : null,
					input.enabled === false ? 0 : 1,
					principal.userId,
					now,
					now,
				],
			);
			this.writeRules(id, rules);
		})();
		this.ctx.audit.record({
			principal,
			action: 'access_policy.create',
			resource: 'access_policy',
			resourceId: id,
			args: { name, scope, rules: rules.length },
			result: 'ok',
		});
		return this.view(this.requireRow(principal.orgId, id));
	}

	update(principal: Principal, id: string, input: AccessPolicyUpdate): AccessPolicyView {
		const row = this.requireRow(principal.orgId, id);
		this.ctx.iam.require(principal, 'accessPolicy:update', refFor(row));
		const patch: Partial<PolicyRow> = { updated_at: this.ctx.now() };
		if (input.name !== undefined) patch.name = input.name.trim();
		if (input.description !== undefined) patch.description = input.description.trim();
		if (input.enabled !== undefined) patch.enabled = input.enabled ? 1 : 0;
		const previousRules = input.rules === undefined ? null : this.rules(id);
		const rules = input.rules === undefined ? null : normalizeRules(input.rules);
		const revoked =
			input.enabled === false ||
			(previousRules !== null && rules !== null && rulesWereRevoked(previousRules, rules));
		this.#sqlite.transaction(() => {
			this.#sqlite.run(
				`UPDATE access_policies SET name = ?, description = ?, enabled = ?, updated_at = ?
				 WHERE id = ? AND org_id = ?`,
				[patch.name ?? row.name, patch.description ?? row.description, patch.enabled ?? row.enabled, patch.updated_at!, id, principal.orgId],
			);
			if (rules) {
				this.#sqlite.run('DELETE FROM access_policy_rules WHERE policy_id = ?', [id]);
				this.writeRules(id, rules);
			}
		})();
		// Removing or tightening a rule (or disabling the policy) is a revocation: bump only this
		// policy's version. The version is part of each host's site key, so cookies and callback
		// tokens issued under the old policy stop verifying while other policies on the same
		// project keep their visitors signed in. Adding a service token is not a revocation.
		if (revoked) this.bumpPolicyVersion(id);
		this.ctx.audit.record({
			principal,
			action: 'access_policy.update',
			resource: 'access_policy',
			resourceId: id,
			args: { ...input, rules: rules?.length, revoked },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.view(this.requireRow(principal.orgId, id));
	}

	remove(principal: Principal, id: string): void {
		const row = this.requireRow(principal.orgId, id);
		this.ctx.iam.require(principal, 'accessPolicy:delete', refFor(row));
		const assigned = this.#sqlite
			.query<{ id: string }, [string, string, string]>(
				`SELECT id FROM projects WHERE (production_access_policy_id = ? OR preview_access_policy_id = ?)
				   AND org_id = ? LIMIT 1`,
			)
			.get(id, id, principal.orgId);
		const assignedEnv = this.#sqlite
			.query<{ id: string }, [string]>('SELECT id FROM environments WHERE access_policy_id = ? LIMIT 1')
			.get(id);
		if (assigned || assignedEnv)
			throw new ValidationError('Turn Yoal Access off for every host using this policy before deleting it.');
		this.#sqlite.transaction(() => {
			this.#sqlite.run('DELETE FROM access_service_tokens WHERE policy_id = ? AND org_id = ?', [
				id,
				principal.orgId,
			]);
			this.#sqlite.run('DELETE FROM access_policy_rules WHERE policy_id = ?', [id]);
			this.#sqlite.run('DELETE FROM access_policies WHERE id = ? AND org_id = ?', [id, principal.orgId]);
		})();
		this.ctx.audit.record({
			principal,
			action: 'access_policy.delete',
			resource: 'access_policy',
			resourceId: id,
			result: 'ok',
		});
	}

	/** Turn Yoal Access on (or off) for one project scope or named environment. */
	assign(principal: Principal, project: ProjectRow, input: AccessPolicyAssignInput): void {
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		if (input.scope === 'environment' && !input.environmentId)
			throw new ValidationError('Name the environment to update.');
		const environment =
			input.scope === 'environment'
				? this.#sqlite
						.query<{ id: string; accessPolicyId: string | null }, [string, string]>(
							'SELECT id, access_policy_id AS accessPolicyId FROM environments WHERE id = ? AND project_id = ?',
						)
						.get(input.environmentId!, project.id)
				: undefined;
		if (input.scope === 'environment' && !environment) throw new NotFoundError('Environment');

		if (input.policyId) {
			const policy = this.requireRow(principal.orgId, input.policyId);
			if (!policy.enabled) throw new ValidationError('Enable this policy before assigning it.');
			const scope = scopeOf(policy);
			if (scope.type === 'project' && scope.id !== project.id)
				throw new ValidationError('A project policy can only be used by its own project.');
			if (scope.type === 'environment' && scope.id !== environment?.id)
				throw new ValidationError('An environment policy can only be used by its own environment.');
		}

		const now = this.ctx.now();
		const previousPolicyId =
			input.scope === 'environment'
				? (environment!.accessPolicyId ?? null)
				: input.scope === 'production'
					? (project.productionAccessPolicyId ?? null)
					: (project.previewAccessPolicyId ?? null);
		const changed = previousPolicyId !== (input.policyId ?? null);
		this.#sqlite.transaction(() => {
			if (input.scope === 'environment') {
				this.#sqlite.run(
					`UPDATE environments
					 SET access_policy_id = ?, access = CASE WHEN ? IS NULL THEN access ELSE 'platform' END,
					     updated_at = ?
					 WHERE id = ?`,
					[input.policyId, input.policyId, now, environment!.id],
				);
			} else if (input.scope === 'production') {
				this.#sqlite.run(
					`UPDATE projects
					 SET production_access_policy_id = ?,
					     production_access = CASE WHEN ? IS NULL THEN production_access ELSE 'platform' END,
					     updated_at = ?
					 WHERE id = ?`,
					[input.policyId, input.policyId, now, project.id],
				);
			} else {
				this.#sqlite.run(
					`UPDATE projects
					 SET preview_access_policy_id = ?,
					     preview_access = CASE WHEN ? IS NULL THEN preview_access ELSE 'platform' END,
					     updated_at = ?
					 WHERE id = ?`,
					[input.policyId, input.policyId, now, project.id],
				);
			}
		})();
		// Changing which policy guards a host is also a revocation: the host's next cookie is minted
		// under the new decision, and every cookie issued under the previous one stops verifying.
		if (changed) this.bumpProjectEpoch(project.id, now);
		this.ctx.projects.bump(principal.orgId);
		this.ctx.audit.record({
			principal,
			action: 'access_policy.assign',
			resource: 'project',
			resourceId: project.id,
			args: { scope: input.scope, environmentId: input.environmentId, policyId: input.policyId },
			result: 'ok',
		});
	}

	// ---------------------------------------------------------------- internals

	/**
	 * Bump one policy's revocation version. Every host using the policy gets a new site key on
	 * its next desired-state pull; hosts using other policies keep theirs.
	 */
	private bumpPolicyVersion(policyId: string): void {
		this.#sqlite.run(
			'UPDATE access_policies SET version = version + 1, updated_at = ? WHERE id = ?',
			[this.ctx.now(), policyId],
		);
	}

	/**
	 * Bump a project's visitor-session epoch. The site key is derived from it, so every cookie and
	 * callback token signed before now stops verifying on the agents (IAM.md §11.1 revocation).
	 */
	private bumpProjectEpoch(projectId: string, now: number): void {
		this.#sqlite.run(
			'UPDATE projects SET site_session_epoch = site_session_epoch + 1, updated_at = ? WHERE id = ?',
			[now, projectId],
		);
	}

	private requireRow(orgId: string, id: string): PolicyRow {
		const row = this.#sqlite
			.query<PolicyRow, [string, string]>('SELECT * FROM access_policies WHERE id = ? AND org_id = ?')
			.get(id, orgId);
		if (!row) throw new NotFoundError('Access policy');
		return row;
	}

	private requireServiceTokenRow(policyId: string, tokenId: string): ServiceTokenRow {
		const row = this.#sqlite
			.query<ServiceTokenRow, [string, string]>(
				'SELECT * FROM access_service_tokens WHERE id = ? AND policy_id = ?',
			)
			.get(tokenId, policyId);
		if (!row) throw new NotFoundError('Service token');
		return row;
	}

	/** Active DB tokens in the edge's shape; header names are normalised like legacy rules. */
	private activeServiceTokenRules(policyId: string): AccessServiceTokenRule[] {
		return this.#sqlite
			.query<{ header: string; token_hash: string }, [string]>(
				`SELECT header, token_hash FROM access_service_tokens
				 WHERE policy_id = ? AND revoked_at IS NULL
				 ORDER BY created_at`,
			)
			.all(policyId)
			.map((token) => ({
				header: token.header.toLowerCase(),
				tokenHash: token.token_hash.toLowerCase(),
				action: 'allow' as const,
			}));
	}

	private validateScope(principal: Principal, scope: AccessPolicyScope): AccessPolicyScope {
		if (scope.type === 'org') return scope;
		if (scope.type === 'project') {
			const project = this.#sqlite
				.query<{ id: string }, [string, string]>(
					'SELECT id FROM projects WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
				)
				.get(scope.id, principal.orgId);
			if (!project) throw new NotFoundError('Project');
			return scope;
		}
		const environment = this.#sqlite
			.query<{ id: string }, [string, string, string]>(
				'SELECT id FROM environments WHERE id = ? AND project_id = ? AND org_id = ?',
			)
			.get(scope.id, scope.projectId, principal.orgId);
		if (!environment) throw new NotFoundError('Environment');
		return scope;
	}

	private view(row: PolicyRow): AccessPolicyView {
		return {
			id: row.id,
			orgId: row.org_id,
			name: row.name,
			description: row.description,
			scope: scopeOf(row),
			enabled: row.enabled === 1,
			version: row.version ?? 0,
			rules: this.rules(row.id),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private rules(policyId: string): AccessPolicyRule[] {
		return this.#sqlite
			.query<RuleRow, [string]>('SELECT idx, action, matcher_json FROM access_policy_rules WHERE policy_id = ? ORDER BY idx')
			.all(policyId)
			.flatMap((row) => {
				let matcher: unknown;
				try {
					matcher = JSON.parse(row.matcher_json);
				} catch {
					return [];
				}
				const parsed = accessPolicyRuleSchema.safeParse({
					idx: row.idx,
					action: row.action,
					matcher,
				});
				return parsed.success ? [parsed.data] : [];
			});
	}

	private writeRules(policyId: string, rules: readonly AccessPolicyRule[]): void {
		for (const rule of rules)
			this.#sqlite.run(
				'INSERT INTO access_policy_rules (policy_id, idx, action, matcher_json) VALUES (?, ?, ?, ?)',
				[policyId, rule.idx, rule.action, JSON.stringify(rule.matcher)],
			);
	}
}

function scopeOf(row: Pick<PolicyRow, 'scope_type' | 'scope_id' | 'scope_parent_id'>): AccessPolicyScope {
	if (row.scope_type === 'project' && row.scope_id) return { type: 'project', id: row.scope_id };
	if (row.scope_type === 'environment' && row.scope_id && row.scope_parent_id)
		return { type: 'environment', id: row.scope_id, projectId: row.scope_parent_id };
	return { type: 'org' };
}

/** The resource ref an existing policy is authorised against. Project bindings cover it through
 * `projectId`; environment bindings through `environmentId`. */
function refFor(row: PolicyRow): ResourceRef {
	const scope = scopeOf(row);
	if (scope.type === 'project') return { type: 'accessPolicy', id: row.id, projectId: scope.id };
	if (scope.type === 'environment')
		return { type: 'accessPolicy', id: row.id, projectId: scope.projectId, environmentId: scope.id };
	return { type: 'accessPolicy', id: row.id };
}

function createRef(scope: AccessPolicyScope): ResourceRef {
	if (scope.type === 'project') return { type: 'project', id: scope.id };
	if (scope.type === 'environment')
		return { type: 'environment', id: scope.id, projectId: scope.projectId };
	return { type: 'org' };
}

/** Rules keep the submitted order; `idx` is rewritten so stored order is unambiguous. */
function normalizeRules(rules: readonly AccessPolicyRule[]): AccessPolicyRule[] {
	if (rules.length > 100) throw new ValidationError('A policy may have at most 100 rules.');
	return rules.map((rule, index) => ({
		idx: index,
		action: rule.action,
		matcher: accessPolicyMatcherSchema.parse(rule.matcher),
	}));
}

/** True when an existing rule is gone or changed: a removal, a new deny, or a new token hash. */
function rulesWereRevoked(before: readonly AccessPolicyRule[], after: readonly AccessPolicyRule[]): boolean {
	const next = new Set(after.map(ruleKey));
	return before.some((rule) => !next.has(ruleKey(rule)));
}

function ruleKey(rule: AccessPolicyRule): string {
	return JSON.stringify([rule.action, rule.matcher]);
}

function serviceTokenView(row: ServiceTokenRow): AccessServiceToken {
	return {
		id: row.id,
		policyId: row.policy_id,
		name: row.name,
		header: row.header,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
		revokedAt: row.revoked_at,
	};
}

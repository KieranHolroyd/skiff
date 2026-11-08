/**
 * The authorization decision (IAM.md I10, §5).
 *
 * This module is pure: no database, clock or network. Callers compile a principal's bindings once
 * (`compileGrants`) and then call `authorize` for each check. The impure half — loading bindings,
 * the `iamVersion` cache, audit — lives in `packages/core/src/iam/`.
 *
 * Scope nesting and the deny-wins rule are IAM.md §2:
 *
 *   allowed = a binding grants the permission at a scope containing the resource
 *         AND the binding's condition holds
 *         AND the credential's restriction permits it
 *         AND no guardrail denies it
 */
import type { Permission } from './catalog.ts';
import type { CredentialKind } from '../principal.ts';

/** Where a binding applies. `platform` is separate from `org` and never confers org access. */
export type ScopeRef =
	| { type: 'platform' }
	| { type: 'org' }
	| { type: 'project'; id: string }
	| { type: 'environment'; projectId: string; id: string }
	| {
			type:
				| 'deployment'
				| 'secret'
				| 'build'
				| 'database'
				| 'storage'
				| 'broker'
				| 'emailDomain'
				| 'shareLink'
				| 'container'
				| 'repository'
				| 'pipelineRepository'
				| 'userPool'
				| 'accessPolicy'
				| 'apiKey';
			id: string;
			/** The project the resource belongs to, when it has one. */
			projectId?: string;
	  };

/** The resource being checked. Resources that live in a project/environment carry its id so a
 * project- or environment-scope binding covers them. */
export interface ResourceRef {
	type: ScopeRef['type'];
	id?: string;
	projectId?: string;
	environmentId?: string;
}

export type Condition =
	| { op: 'before'; at: number }
	| { op: 'after'; at: number }
	| { op: 'ipIn'; cidrs: readonly string[] }
	| { op: 'credentialIn'; credentials: readonly CredentialKind[] }
	| { op: 'environmentIn'; environments: readonly string[] }
	| { op: 'freshAuth'; class: 'strong' | 'basic' };

/** What the credential may carry. It never adds access, only narrows it (IAM.md §2). */
export interface Restriction {
	/** Permission ceiling. Absent means the binding's permissions are the only ceiling. */
	permissions?: readonly Permission[];
	/** Resource ceiling as `type:id` or `type:*`. A resource not listed is not permitted. */
	resources?: readonly string[];
}

export interface Guardrail {
	id: string;
	/** `all` denies every permission; `resource:*` covers a whole resource. */
	permissions: readonly Permission[] | readonly string[];
	scope?: ScopeRef;
	condition?: Condition;
}

/** A binding with its role already resolved to permissions. */
export interface Binding {
	id: string;
	roleId: string;
	permissions: readonly Permission[];
	scope: ScopeRef;
	expiresAt?: number | null;
	condition?: Condition | null;
}

export interface CompiledGrant {
	bindingId: string;
	roleId: string;
	permission: Permission;
	scope: ScopeRef;
	expiresAt?: number | null;
	condition?: Condition | null;
}

export interface CompiledGrants {
	orgId: string;
	/** Permission → grants that mention it, so an org-wide check is one map lookup. */
	index: ReadonlyMap<Permission, readonly CompiledGrant[]>;
	guardrails: readonly Guardrail[];
	restriction?: Restriction;
}

export interface EvaluationContext {
	/** Epoch ms. */
	now: number;
	ip?: string;
	credential?: CredentialKind;
	/** The environment name (`production`, `preview`, a named environment) if known. */
	environment?: string;
	/** A step-up verification proved in this session, when there was one. */
	verification?: { class: 'strong' | 'basic'; at: number };
	/** How long a verification stays fresh. STEP-UP.md §3: 30 minutes. */
	freshWindowMs?: number;
}

export type DecisionReason =
	| 'binding'
	| 'no-binding'
	| 'expired'
	| 'condition'
	| 'restricted'
	| 'guardrail';

/** One binding's outcome, for `iam.explain` and the "why can't I?" page. */
export interface GrantEvaluation {
	bindingId: string;
	roleId: string;
	scope: ScopeRef;
	outcome: 'allow' | 'expired' | 'condition' | 'scope' | 'restricted';
}

export interface Decision {
	allow: boolean;
	reason: DecisionReason;
	/** The binding or guardrail that decided it. */
	via?: string;
	/** Every grant considered for the permission, so an explain can show the whole chain. */
	chain: readonly GrantEvaluation[];
}

/** Compile a principal's bindings once, then check many permissions. */
export function compileGrants(input: {
	orgId: string;
	bindings: readonly Binding[];
	guardrails?: readonly Guardrail[];
	restriction?: Restriction;
}): CompiledGrants {
	const index = new Map<Permission, CompiledGrant[]>();
	for (const binding of input.bindings) {
		for (const permission of binding.permissions) {
			const grants = index.get(permission) ?? [];
			grants.push({
				bindingId: binding.id,
				roleId: binding.roleId,
				permission,
				scope: binding.scope,
				expiresAt: binding.expiresAt,
				condition: binding.condition,
			});
			index.set(permission, grants);
		}
	}
	return {
		orgId: input.orgId,
		index,
		guardrails: input.guardrails ?? [],
		restriction: input.restriction,
	};
}

/** Does `scope` cover `resource`? See the nesting table in IAM.md §2. */
export function scopeContains(scope: ScopeRef, resource: ResourceRef): boolean {
	switch (scope.type) {
		case 'platform':
			return resource.type === 'platform';
		case 'org':
			return resource.type !== 'platform';
		case 'project':
			return (
				(resource.type === 'project' && resource.id === scope.id) ||
				resource.projectId === scope.id
			);
		case 'environment':
			return (
				(resource.type === 'environment' &&
					resource.id === scope.id &&
					resource.projectId === scope.projectId) ||
				(resource.environmentId === scope.id && resource.projectId === scope.projectId)
			);
		default:
			return (
				scope.type === resource.type &&
				scope.id === resource.id &&
				(scope.projectId === undefined ||
					resource.projectId === undefined ||
					scope.projectId === resource.projectId)
			);
	}
}

/**
 * The decision. Everything unrecognised fails closed: an unknown condition, a credential with no
 * matching rule, or a resource outside every binding all deny.
 */
export function authorize(
	grants: CompiledGrants,
	request: { permission: Permission; resource: ResourceRef; context?: EvaluationContext },
): Decision {
	const chain: GrantEvaluation[] = [];
	const candidates = grants.index.get(request.permission) ?? [];
	const context = request.context;

	for (const grant of candidates) {
		const inScope = scopeContains(grant.scope, request.resource);
		if (!inScope) {
			chain.push(evaluate(grant, 'scope'));
			continue;
		}
		if (grant.expiresAt != null && context && context.now >= grant.expiresAt) {
			chain.push(evaluate(grant, 'expired'));
			continue;
		}
		if (grant.condition && !conditionHolds(grant.condition, request, grants, context)) {
			chain.push(evaluate(grant, 'condition'));
			continue;
		}
		if (!restrictionAllows(grants.restriction, request.permission, request.resource)) {
			chain.push(evaluate(grant, 'restricted'));
			continue;
		}
		chain.push(evaluate(grant, 'allow'));
	}

	// A guardrail beats every allow, including the platform's (IAM.md §9.2).
	for (const guardrail of grants.guardrails) {
		if (!permissionMatches(guardrail.permissions, request.permission)) continue;
		if (guardrail.scope && !scopeContains(guardrail.scope, request.resource)) continue;
		if (guardrail.condition && !conditionHolds(guardrail.condition, request, grants, context))
			continue;
		return { allow: false, reason: 'guardrail', via: guardrail.id, chain };
	}

	const allowed = chain.find((entry) => entry.outcome === 'allow');
	if (allowed) return { allow: true, reason: 'binding', via: allowed.bindingId, chain };

	if (candidates.length === 0) return { allow: false, reason: 'no-binding', chain };
	if (chain.some((entry) => entry.outcome === 'restricted'))
		return { allow: false, reason: 'restricted', chain };
	if (chain.some((entry) => entry.outcome === 'expired'))
		return { allow: false, reason: 'expired', chain };
	if (chain.some((entry) => entry.outcome === 'condition'))
		return { allow: false, reason: 'condition', chain };
	return { allow: false, reason: 'no-binding', chain };
}

function evaluate(grant: CompiledGrant, outcome: GrantEvaluation['outcome']): GrantEvaluation {
	return {
		bindingId: grant.bindingId,
		roleId: grant.roleId,
		scope: grant.scope,
		outcome,
	};
}

function permissionMatches(
	permissions: readonly string[],
	permission: Permission,
): boolean {
	if (permissions.includes('all') || permissions.includes('*:*')) return true;
	if (permissions.includes(permission)) return true;
	const resource = permission.slice(0, permission.indexOf(':'));
	return permissions.includes(`${resource}:*`);
}

function restrictionAllows(
	restriction: Restriction | undefined,
	permission: Permission,
	resource: ResourceRef,
): boolean {
	if (!restriction) return true;
	if (restriction.permissions && !permissionMatches(restriction.permissions, permission))
		return false;
	if (restriction.resources) {
		const type = resource.type;
		const id = resource.id ?? '*';
		const allowed =
			restriction.resources.includes(`${type}:${id}`) ||
			restriction.resources.includes(`${type}:*`) ||
			(type !== 'platform' && restriction.resources.includes('*:*'));
		if (!allowed) return false;
	}
	return true;
}

function conditionHolds(
	condition: Condition,
	request: { permission: Permission; resource: ResourceRef },
	grants: CompiledGrants,
	context: EvaluationContext | undefined,
): boolean {
	// A condition that needs request context denies when the caller couldn't supply it.
	switch (condition.op) {
		case 'before':
			return context !== undefined && context.now < condition.at;
		case 'after':
			return context !== undefined && context.now >= condition.at;
		case 'ipIn': {
			const ip = context?.ip;
			return ip !== undefined && condition.cidrs.some((cidr) => ipInCidr(ip, cidr));
		}
		case 'credentialIn':
			return context?.credential !== undefined && condition.credentials.includes(context.credential);
		case 'environmentIn':
			return context?.environment !== undefined && condition.environments.includes(context.environment);
		case 'freshAuth': {
			if (!context?.verification) return false;
			const windowMs = context.freshWindowMs ?? 30 * 60 * 1000;
			const freshEnough = context.now - context.verification.at < windowMs;
			const classEnough =
				condition.class === 'basic' || context.verification.class === 'strong';
			return freshEnough && classEnough;
		}
		default:
			// A condition this engine does not understand fails closed (IAM.md §5.4).
			return false;
	}
}

/** IPv4 CIDR or bare address. IPv6 fails closed until the engine moves to a library. */
export function ipInCidr(ip: string, cidr: string): boolean {
	const [network, bitsRaw] = cidr.split('/');
	const address = parseIpv4(ip);
	const base = parseIpv4(network ?? '');
	if (address === null || base === null) return false;
	const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
	if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
	if (bits === 0) return true;
	const mask = (0xffffffff << (32 - bits)) >>> 0;
	return (address & mask) === (base & mask);
}

function parseIpv4(value: string): number | null {
	const parts = value.trim().split('.');
	if (parts.length !== 4) return null;
	let result = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		result = ((result << 8) | octet) >>> 0;
	}
	return result;
}

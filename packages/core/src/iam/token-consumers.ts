/**
 * Skiff token consumers (docs/IAM.md I16–I18, §7.3–§7.4).
 *
 * A workload token and an STS access token both name a service account (`sub`), its org
 * (`org_id`) and, optionally, a ceiling (`scope` = space-separated permissions, `resources` =
 * `type:id` entries). This module turns those claims into a `Principal` the services already
 * understand, so REST, MCP and the registry realm share one verification path instead of each
 * rolling its own JWT handling.
 *
 * Verification is the ring's: the signature, issuer (`iss` = platform origin) and expiry are
 * checked by `SigningKeyService.verify`, and the caller passes the audiences it accepts. A token
 * whose service account is missing or disabled, or whose `org_id` no longer matches the account,
 * is refused even though the signature is valid.
 */
import {
	WORKLOAD_IDENTITY_AUDIENCE,
	isPermission,
	type Permission,
	type Principal,
	type Restriction,
} from '@skiff/contracts';
import type { CoreContext } from '../context.ts';
import type { JwtClaims } from './keys.ts';

/** The two ring purposes a surface accepts as a bearer credential. */
export type SkiffTokenKind = 'workload' | 'sts';

/** A verified workload or STS token, reduced to what a principal needs. */
export interface SkiffTokenIdentity {
	kind: SkiffTokenKind;
	/** The service account the token names (`sub`). */
	serviceAccountId: string;
	/** The org the token was minted for (`org_id`). */
	orgId: string;
	/** The token's own ceiling, from `scope`/`resources`; absent means the bindings are the ceiling. */
	restriction?: Restriction;
	claims: JwtClaims;
}

export interface SkiffTokenAudiences {
	/** Audiences accepted for a workload token. Defaults to `skiff`. */
	workloadAudiences?: readonly string[];
	/** Audiences accepted for an STS token. Defaults to `skiff` and the platform origin. */
	stsAudiences?: readonly string[];
}

/**
 * Read a token's ceiling. `scope` names catalog permissions and is narrowed by the token's own
 * resource list; either may be absent. Unknown permission strings are dropped, never widened.
 */
export function restrictionFromClaims(claims: Record<string, unknown>): Restriction | undefined {
	const scope = typeof claims.scope === 'string' ? claims.scope.trim() : '';
	const permissions = scope
		.split(/\s+/)
		.filter(Boolean)
		.filter((permission): permission is Permission => isPermission(permission));
	const resources = Array.isArray(claims.resources)
		? claims.resources.filter((resource): resource is string => typeof resource === 'string')
		: [];
	if (!scope && resources.length === 0) return undefined;
	// A scope that named nothing usable is an empty ceiling, not an absent one: never widen.
	return {
		...(scope ? { permissions } : {}),
		...(resources.length > 0 ? { resources } : {}),
	};
}

/**
 * The identity a verified token names. Pure: audience, issuer, signature and expiry were already
 * checked, so this only insists on the claims every Skiff token carries.
 */
export function skiffTokenIdentity(
	kind: SkiffTokenKind,
	claims: JwtClaims,
): SkiffTokenIdentity | null {
	const serviceAccountId = typeof claims.sub === 'string' ? claims.sub : '';
	const orgId = typeof claims.org_id === 'string' ? claims.org_id : '';
	if (!serviceAccountId || !orgId) return null;
	return {
		kind,
		serviceAccountId,
		orgId,
		restriction: restrictionFromClaims(claims),
		claims,
	};
}

/**
 * Verify a bearer token as a workload or STS token and return the identity it names, or null when
 * it is not one of ours. Both purposes are tried in turn: a `kid` belongs to exactly one purpose.
 */
export async function verifySkiffToken(
	ctx: CoreContext,
	token: string,
	audiences: SkiffTokenAudiences = {},
): Promise<SkiffTokenIdentity | null> {
	const attempts: Array<[SkiffTokenKind, readonly string[]]> = [
		['workload', audiences.workloadAudiences ?? [WORKLOAD_IDENTITY_AUDIENCE]],
		[
			'sts',
			audiences.stsAudiences ?? [WORKLOAD_IDENTITY_AUDIENCE, ctx.config.platformOrigin],
		],
	];
	for (const [kind, accepted] of attempts) {
		for (const audience of accepted) {
			try {
				const claims = await ctx.signingKeys.verify(kind, token, { audience });
				const identity = skiffTokenIdentity(kind, claims);
				if (identity && serviceAccountUsable(ctx, identity)) return identity;
			} catch {
				// Wrong purpose, audience, signature, issuer or expiry: try the next attempt.
			}
		}
	}
	return null;
}

/**
 * Build the service-account shell a token stands for. Its bindings are compiled separately, so a
 * caller that does not need permissions (e.g. a pure claims test) can use this on its own.
 */
export function principalFromSkiffToken(
	identity: SkiffTokenIdentity,
	permissions: Iterable<Permission> = [],
): Principal {
	return {
		kind: 'serviceAccount',
		userId: identity.serviceAccountId,
		orgId: identity.orgId,
		role: 'viewer',
		permissions: new Set(permissions),
		credential: identity.kind,
		...(identity.restriction ? { restriction: identity.restriction } : {}),
	};
}

/**
 * The full principal for a surface: the account's compiled bindings, narrowed by the token's
 * `scope` so call sites that read `principal.permissions` directly (rather than the engine) also
 * see the token's ceiling. Resource restrictions are enforced by `IamService` through the
 * principal's `restriction`.
 */
export function serviceAccountPrincipalFromSkiffToken(
	ctx: CoreContext,
	identity: SkiffTokenIdentity,
): Principal {
	const shell = principalFromSkiffToken(identity);
	const bound = [...ctx.iam.compiledFor(shell).index.keys()];
	const ceiling = identity.restriction?.permissions;
	return {
		...shell,
		permissions: new Set(
			ceiling ? bound.filter((permission) => ceiling.includes(permission)) : bound,
		),
	};
}

/**
 * Does a token's ceiling permit this permission on any of the candidate resources? Used by
 * surfaces that check `principal.permissions` directly (the registry realm maps a Docker scope to
 * a repository name before a repository row exists). A resource list absent means no resource
 * ceiling; a permission list absent means the bindings are the permission ceiling.
 */
export function tokenRestrictionAllows(
	restriction: Restriction | undefined,
	permission: Permission,
	resources: readonly string[] = [],
): boolean {
	if (!restriction) return true;
	if (restriction.permissions && !permissionCovered(restriction.permissions, permission))
		return false;
	if (restriction.resources) {
		const allowed = restriction.resources;
		if (
			!resources.some(
				(resource) =>
					allowed.includes(resource) ||
					allowed.includes(`${resource.split(':')[0]}:*`) ||
					(!resource.startsWith('platform:') && allowed.includes('*:*')),
			)
		)
			return false;
	}
	return true;
}

function permissionCovered(permissions: readonly Permission[], permission: Permission): boolean {
	const resource = permission.slice(0, permission.indexOf(':'));
	const wildcards = permissions as readonly string[];
	return (
		wildcards.includes(permission) ||
		wildcards.includes(`${resource}:*`) ||
		wildcards.includes('*:*') ||
		wildcards.includes('all')
	);
}

/** A token is only as good as its service account: same org, not disabled. */
function serviceAccountUsable(ctx: CoreContext, identity: SkiffTokenIdentity): boolean {
	const row = ctx.sqlite
		.query<{ org_id: string; disabled_at: number | null }, [string]>(
			'SELECT org_id, disabled_at FROM service_accounts WHERE id = ?',
		)
		.get(identity.serviceAccountId);
	return Boolean(row && row.org_id === identity.orgId && row.disabled_at === null);
}

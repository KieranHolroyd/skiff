import type { RequestEvent } from '@sveltejs/kit';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { buildPrincipal, isPlatformAdminUser, resolveMembership } from '@skiff/core';
import type { AccessKeyVerification, Membership, SkiffTokenAudiences } from '@skiff/core';
import { serviceAccountPrincipalFromSkiffToken, verifySkiffToken } from '@skiff/core';
import type { Permission, Principal, Role } from '@skiff/contracts';
import {
	WORKLOAD_IDENTITY_AUDIENCE,
	effectivePermissions,
	isPermission,
	roles as roleDefinitions,
} from '@skiff/contracts';
import { auth } from './auth';
import { openSignup } from './config';
import { core } from './core';
import { sqlite } from './db';
import { membershipRoleIn } from './org-membership';
import { verificationFromSession } from './step-up';

/** The request's client address, before it is hashed for audit or storage. */
function clientIp(request: Request): string | undefined {
	return (
		request.headers.get('cf-connecting-ip') ??
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
		request.headers.get('x-real-ip') ??
		undefined
	);
}

function hashIp(request: Request): string | undefined {
	const ip = clientIp(request);
	if (!ip) return undefined;
	// Never store a raw IP; a salted truncated hash is enough for abuse correlation.
	return new Bun.CryptoHasher('sha256').update(`ip:${ip}`).digest('hex').slice(0, 16);
}

/**
 * Resolve a dashboard/browser session into the shared Principal shape. Returns `undefined` for a
 * signed-in user who belongs to no org yet (an invitee who hasn't accepted): they can reach
 * `/accept-invitation/*` but no org-scoped surface.
 *
 * The org is the credential's, then the session's `activeOrganizationId` when it is a membership,
 * then the first membership (IAM.md I5, §8.1). `resolveMembership` remains the fallback because
 * the setup wizard and open-signup bootstrap create the user's org on first use.
 */
export function principalFromSession(
	userId: string,
	request: Request,
	options: {
		name?: string;
		granted?: Iterable<string>;
		kind?: Principal['kind'];
		/** `session.activeOrganizationId`: the org the caller last switched to. */
		activeOrganizationId?: string | null;
		/** A credential's bound org (an API key's `org_id`); it wins and never falls back. */
		orgId?: string;
		/** The Better Auth session row; its optional step-up fields become `Principal.verification`. */
		session?: unknown;
	} = {},
): Principal | undefined {
	const membership = membershipFrom(userId, options);
	if (!membership) return undefined;
	const principal = buildPrincipal({
		userId,
		orgId: membership.orgId,
		role: membership.role,
		kind: options.kind ?? 'user',
		granted: options.granted,
		ipHash: hashIp(request),
		platformAdmin: isPlatformAdminUser(sqlite, userId),
	});
	// STEP-UP.md §6: only a session row can carry a verification window. A key or MCP principal
	// cannot show a dialog, so it stays undefined and the catalog's token rule decides (§7).
	if (options.kind === undefined || options.kind === 'user') {
		const verification = verificationFromSession(options.session);
		if (verification) principal.verification = verification;
	}
	return principal;
}

function membershipFrom(
	userId: string,
	options: { name?: string; activeOrganizationId?: string | null; orgId?: string },
): Membership | undefined {
	if (options.orgId) {
		const role = membershipRoleIn(options.orgId, userId);
		return role ? { orgId: options.orgId, role } : undefined;
	}
	if (options.activeOrganizationId) {
		const role = membershipRoleIn(options.activeOrganizationId, userId);
		if (role) return { orgId: options.activeOrganizationId, role };
	}
	return resolveMembership(sqlite, userId, { fallbackName: options.name, openSignup });
}

/**
 * REST authentication: a Skiff access key (`skif_…`, IAM.md I14), a Better Auth API key
 * (`skif_…`) that has not been migrated yet, a Skiff workload/STS token (IAM.md §7.3–§7.4), or
 * the session cookie.
 *
 * Access keys are tried first: `AccessKeyService.verify` accepts both Skiff's `sha256` rows and
 * migrated Better Auth rows (`hash_scheme = 'better-auth'`, spike S1), so a migrated key never
 * pays Better Auth's rate-limit/usage side effects. Anything it does not recognise falls back to
 * `verifyApiKey` for an `apikey` row the one-time migration has not copied. Neither path deletes
 * `apikey` rows. The dashboard (settings/api-keys) and CLI login (api/v1/cli/token) still mint
 * Better Auth rows; both stamp `metadata.orgId`, so a key stays in the org it was created in.
 * MCP OAuth tokens are audience-bound to `/mcp` and verified there, not accepted by the REST API.
 */
export async function principalFromRequest(request: Request): Promise<Principal | undefined> {
	const authorization = request.headers.get('authorization');
	if (authorization?.startsWith('Bearer ')) {
		const key = authorization.slice(7).trim();
		if (key.startsWith('skif_')) {
			// The raw IP is only used for the CIDR check; the principal carries its hash.
			const verified = core.ctx.accessKeys.verify(key, { ip: clientIp(request) });
			if (verified) return principalFromAccessKey(verified, request);

			// A migrated row is authoritative even when `verify` rejected it (revoked, expired or
			// CIDR mismatch): falling back to Better Auth would revive a key Skiff just revoked.
			if (core.ctx.accessKeys.recognizes(key)) return undefined;

			// Not a migrated/Skiff access key: fall back to Better Auth for rows the one-time
			// migration has not copied yet (spike S1). New keys are Skiff-only.
			const result = await auth.api.verifyApiKey({ body: { key } }).catch(() => undefined);
			if (result?.valid && result.key) {
				const userId = result.key.referenceId;
				const metadata = parseMetadata(result.key.metadata);
				const granted = metadata.scopes ?? metadata.permissions;
				const principal = principalFromSession(userId, request, {
					kind: 'apiKey',
					granted: Array.isArray(granted) ? granted : undefined,
					// Keys created since I5 carry the org they were minted in, so switching orgs or
					// joining another one never moves an existing key (IAM.md I5, I14).
					orgId: typeof metadata.orgId === 'string' ? metadata.orgId : undefined,
				});
				if (!principal) return undefined;
				principal.keyId = result.key.id;
				return principal;
			}
			return undefined;
		}

		// A Skiff workload or STS token. It names a service account and its org, and can only carry
		// the bindings that account holds, narrowed by the token's own scope/resources.
		return principalFromSkiffBearer(key, request, {
			workloadAudiences: [WORKLOAD_IDENTITY_AUDIENCE],
			stsAudiences: [WORKLOAD_IDENTITY_AUDIENCE, core.ctx.config.platformOrigin],
		});
	}

	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) return undefined;
	return principalFromSession(session.user.id, request, {
		name: session.user.name ?? undefined,
		activeOrganizationId: session.session.activeOrganizationId,
		session: session.session,
	});
}

/**
 * A workload or STS bearer token, for the surfaces that accept one (REST, MCP, the registry
 * realm). The token must be signed by Skiff's ring, unexpired, issued by the platform, and carry
 * one of the accepted audiences; its service account must still exist in the org it names.
 * Returns undefined for anything else, so a caller can fall back to its own credential path.
 */
export async function principalFromSkiffBearer(
	token: string,
	request: Request,
	audiences: SkiffTokenAudiences = {},
): Promise<Principal | undefined> {
	const identity = await verifySkiffToken(core.ctx, token, audiences);
	if (!identity) return undefined;
	return {
		...serviceAccountPrincipalFromSkiffToken(core.ctx, identity),
		ipHash: hashIp(request),
	};
}

/**
 * Build a principal from a verified access-key row. A user key is the user on an `apiKey`
 * credential, with the org role from the key's own org (never the user's first membership). A
 * service-account key acts as the account: its permissions are the bindings compiled for it,
 * narrowed by the key's restriction.
 */
function principalFromAccessKey(
	verified: AccessKeyVerification,
	request: Request,
): Principal | undefined {
	if (verified.principalType === 'serviceAccount') {
		const shell: Principal = {
			kind: 'serviceAccount',
			userId: verified.principalId,
			orgId: verified.orgId,
			role: 'viewer',
			permissions: new Set<Permission>(),
		};
		const bound = new Set<Permission>(core.ctx.iam.compiledFor(shell).index.keys());
		const ceiling = verified.permissions ? new Set<Permission>(verified.permissions) : undefined;
		return {
			...shell,
			permissions: new Set([...bound].filter((permission) => !ceiling || ceiling.has(permission))),
			credential: 'apiKey',
			keyId: verified.keyId,
			ipHash: hashIp(request),
		};
	}

	const role = membershipRoleIn(verified.orgId, verified.principalId);
	// A key outlives its owner's membership only until the next request: no member row, no access.
	if (!role) return undefined;
	return buildPrincipal({
		userId: verified.principalId,
		orgId: verified.orgId,
		role,
		kind: 'apiKey',
		granted: verified.permissions,
		keyId: verified.keyId,
		ipHash: hashIp(request),
		platformAdmin: isPlatformAdminUser(sqlite, verified.principalId),
	});
}

function parseMetadata(metadata: unknown): { scopes?: string[]; permissions?: string[]; orgId?: string } {
	if (!metadata) return {};
	if (typeof metadata === 'string') {
		try {
			return JSON.parse(metadata) as { scopes?: string[]; permissions?: string[]; orgId?: string };
		} catch {
			return {};
		}
	}
	if (typeof metadata === 'object')
		return metadata as { scopes?: string[]; permissions?: string[]; orgId?: string };
	return {};
}

/**
 * MCP principal: scopes from the JWT ∩ the user's current org role (DESIGN §6.3). A workload or
 * STS token has no user to resolve, so the route verifies it and passes the built service-account
 * principal through `authInfo.extra.principal`.
 */
export function principalFromMcp(authInfo: AuthInfo | undefined, request: Request): Principal | undefined {
	if (!authInfo) return undefined;
	const injected = injectedPrincipal(authInfo);
	if (injected) return injected;
	const userId = String(authInfo.extra?.sub ?? '');
	if (!userId) return undefined;
	const membership = resolveMembership(sqlite, userId, { openSignup });
	if (!membership) return undefined;
	const granted = new Set<string>(authInfo.scopes ?? []);
	const permissions = effectivePermissions(granted, membership.role as Role);
	return buildPrincipal({
		userId,
		orgId: membership.orgId,
		role: membership.role,
		kind: 'mcp',
		granted: [...permissions],
		clientId: authInfo.clientId,
		ipHash: hashIp(request),
		platformAdmin: isPlatformAdminUser(sqlite, userId),
	});
}

/** A principal the MCP route already built from a verified workload/STS token. */
function injectedPrincipal(authInfo: AuthInfo): Principal | undefined {
	const value = authInfo.extra?.principal;
	if (!value || typeof value !== 'object') return undefined;
	const principal = value as Partial<Principal>;
	if (typeof principal.userId !== 'string' || typeof principal.orgId !== 'string') return undefined;
	if (typeof principal.kind !== 'string' || !(principal.permissions instanceof Set)) return undefined;
	return principal as Principal;
}

/** Throws a 401 response for API routes. */
export function requirePrincipal(event: RequestEvent): Principal {
	const principal = event.locals.principal as Principal | undefined;
	if (!principal) throw new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
	return principal;
}

export function isPermissionList(values: unknown): values is Permission[] {
	return Array.isArray(values) && values.every((value) => typeof value === 'string' && isPermission(value));
}

export function rolePermissions(role: Role): readonly Permission[] {
	return roleDefinitions[role];
}

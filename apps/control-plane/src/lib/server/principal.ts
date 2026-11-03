import type { RequestEvent } from '@sveltejs/kit';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { buildPrincipal, isPlatformAdminUser, resolveMembership } from '@skiff/core';
import type { Permission, Principal, Role } from '@skiff/contracts';
import { effectivePermissions, isPermission, roles as roleDefinitions } from '@skiff/contracts';
import { auth } from './auth';
import { openSignup } from './config';
import { sqlite } from './db';

function hashIp(request: Request): string | undefined {
	const ip =
		request.headers.get('cf-connecting-ip') ??
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
		request.headers.get('x-real-ip');
	if (!ip) return undefined;
	// Never store a raw IP; a salted truncated hash is enough for abuse correlation.
	return new Bun.CryptoHasher('sha256').update(`ip:${ip}`).digest('hex').slice(0, 16);
}

/**
 * Resolve a dashboard/browser session into the shared Principal shape. Returns `undefined` for a
 * signed-in user who belongs to no org yet (an invitee who hasn't accepted): they can reach
 * `/accept-invitation/*` but no org-scoped surface.
 */
export function principalFromSession(
	userId: string,
	request: Request,
	options: { name?: string; granted?: Iterable<string>; kind?: Principal['kind'] } = {},
): Principal | undefined {
	const membership = resolveMembership(sqlite, userId, { fallbackName: options.name, openSignup });
	if (!membership) return undefined;
	return buildPrincipal({
		userId,
		orgId: membership.orgId,
		role: membership.role,
		kind: options.kind ?? 'user',
		granted: options.granted,
		ipHash: hashIp(request),
		platformAdmin: isPlatformAdminUser(sqlite, userId),
	});
}

/**
 * REST authentication: either a Better Auth API key (`skif_…`) or the session cookie. MCP tokens
 * are audience-bound to `/mcp` and verified there, not accepted by the REST API.
 */
export async function principalFromRequest(request: Request): Promise<Principal | undefined> {
	const authorization = request.headers.get('authorization');
	if (authorization?.startsWith('Bearer ')) {
		const key = authorization.slice(7).trim();
		if (!key.startsWith('skif_')) return undefined;
		const result = await auth.api.verifyApiKey({ body: { key } });
		if (!result.valid || !result.key) return undefined;
		const userId = result.key.referenceId;
		const metadata = parseMetadata(result.key.metadata);
		const granted = metadata.scopes ?? metadata.permissions;
		const principal = principalFromSession(userId, request, {
			kind: 'apiKey',
			granted: Array.isArray(granted) ? granted : undefined,
		});
		if (!principal) return undefined;
		principal.keyId = result.key.id;
		return principal;
	}

	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) return undefined;
	return principalFromSession(session.user.id, request, { name: session.user.name ?? undefined });
}

function parseMetadata(metadata: unknown): { scopes?: string[]; permissions?: string[] } {
	if (!metadata) return {};
	if (typeof metadata === 'string') {
		try {
			return JSON.parse(metadata) as { scopes?: string[]; permissions?: string[] };
		} catch {
			return {};
		}
	}
	if (typeof metadata === 'object') return metadata as { scopes?: string[]; permissions?: string[] };
	return {};
}

/** MCP principal: scopes from the JWT ∩ the user's current org role (DESIGN §6.3). */
export function principalFromMcp(authInfo: AuthInfo | undefined, request: Request): Principal | undefined {
	if (!authInfo) return undefined;
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

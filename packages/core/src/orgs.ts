import type { Database } from 'bun:sqlite';
import type { Permission, Principal, Role } from '@skiff/contracts';
import { roles as roleDefinitions } from '@skiff/contracts';
import { ConflictError, ForbiddenError, ValidationError } from './errors.ts';
import { newId } from './util.ts';

/**
 * Org membership lives in Better Auth's `organization`/`member` tables (D9). The control plane
 * resolves a session into a Principal here; the MCP and API paths use the same function so no
 * surface can out-perform another.
 */
export interface Membership {
	orgId: string;
	role: Role;
}

export function isRole(value: string): value is Role {
	return value in roleDefinitions;
}

export function readMembership(sqlite: Database, userId: string): Membership | undefined {
	try {
		const row = sqlite
			.query<{ organizationId: string; role: string }, [string]>(
				'SELECT organizationId, role FROM member WHERE userId = ? ORDER BY createdAt ASC LIMIT 1',
			)
			.get(userId);
		if (!row) return undefined;
		return { orgId: row.organizationId, role: isRole(row.role) ? row.role : 'viewer' };
	} catch {
		// Auth tables not present (unit tests / bootstrapping before migrations).
		return undefined;
	}
}

/** Create a personal org with the user as owner (see `resolveMembership` for when). */
export function ensurePersonalOrg(sqlite: Database, userId: string, name = 'Personal'): Membership {
	const now = new Date();
	const orgId = newId('org_');
	const slug = `org-${orgId.slice(4, 16)}`;
	sqlite.transaction(() => {
		sqlite.run('INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)', [
			orgId,
			name,
			slug,
			now.toISOString(),
		]);
		sqlite.run(
			'INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)',
			[newId('mem_'), orgId, userId, 'owner', now.toISOString()],
		);
	})();
	return { orgId, role: 'owner' };
}

/**
 * A user's membership, creating a personal org only when that's safe:
 *  - bootstrap: no organization exists yet, so this is the first (owner) user, or
 *  - `openSignup`: self-service installs where every user gets their own org.
 *
 * On an invite-only install (D10) a user without a membership gets `undefined`: an invitee must
 * accept their invitation instead of silently landing in an auto-created org of their own.
 */
export function resolveMembership(
	sqlite: Database,
	userId: string,
	options: { fallbackName?: string; openSignup?: boolean } = {},
): Membership | undefined {
	const existing = readMembership(sqlite, userId);
	if (existing) return existing;
	if (options.openSignup || !hasAnyOrganization(sqlite))
		return ensurePersonalOrg(sqlite, userId, options.fallbackName);
	return undefined;
}

function hasAnyOrganization(sqlite: Database): boolean {
	try {
		return Boolean(sqlite.query('SELECT 1 FROM organization LIMIT 1').get());
	} catch {
		return false;
	}
}

/** Better Auth admin plugin: `user.role` is a comma-separated list; `admin` is the platform admin. */
export function isPlatformAdminUser(sqlite: Database, userId: string): boolean {
	try {
		const row = sqlite.query<{ role: string | null }, [string]>('SELECT role FROM user WHERE id = ?').get(userId);
		return (row?.role ?? '').split(',').some((role) => role.trim() === 'admin');
	} catch {
		return false;
	}
}

export function assertRoleCan(role: Role, permission: Permission): void {
	const allowed = new Set<string>(roleDefinitions[role]);
	if (!allowed.has(permission)) throw new ForbiddenError(permission);
}

/**
 * A token's effective permissions are always `granted scopes ∩ the user's current role`
 * (packages/contracts): revoking a role immediately narrows every token.
 */
export function buildPrincipal(input: {
	userId: string;
	orgId: string;
	role: Role;
	kind: Principal['kind'];
	granted?: Iterable<string>;
	clientId?: string;
	keyId?: string;
	ipHash?: string;
	platformAdmin?: boolean;
	credential?: Principal['credential'];
}): Principal {
	const rolePermissions = new Set<string>(roleDefinitions[input.role]);
	const granted = input.granted ? new Set(input.granted) : rolePermissions;
	const permissions = new Set(
		[...granted].filter((permission) => rolePermissions.has(permission)),
	) as Set<Permission>;
	return {
		kind: input.kind,
		userId: input.userId,
		orgId: input.orgId,
		role: input.role,
		permissions,
		clientId: input.clientId,
		keyId: input.keyId,
		ipHash: input.ipHash,
		platformAdmin: input.platformAdmin === true,
		// The credential a surface check needs: a session-backed `user`, a Better Auth key, an MCP
		// OAuth token, or the named internal actor. Machine kinds set theirs explicitly elsewhere.
		credential: input.credential ?? CREDENTIAL_BY_KIND[input.kind],
	};
}

/** The credential a principal kind proves itself with when the caller doesn't say (IAM.md §7.1). */
const CREDENTIAL_BY_KIND: Partial<Record<Principal['kind'], NonNullable<Principal['credential']>>> = {
	user: 'session',
	apiKey: 'apiKey',
	mcp: 'oauth',
	system: 'system',
	workload: 'workload',
	job: 'job',
	node: 'node',
};

/** A membership change requested from the dashboard (DESIGN §6.2 `member:*`). */
export type MemberChange =
	| { action: 'invite'; role: Role }
	| { action: 'update-role'; targetRole: Role; role: Role; self: boolean }
	| { action: 'remove'; targetRole: Role; self: boolean };

/**
 * Why `actorRole` may not make `change`, or `undefined` when it's allowed. The RBAC permission
 * itself (`member:invite` / `member:update-role` / `member:remove`) is checked separately; these
 * are the ownership rules on top: only owners grant or touch `owner`, and an org always keeps one.
 */
export function memberChangeError(actorRole: Role, change: MemberChange, ownerCount: number): string | undefined {
	const actorIsOwner = actorRole === 'owner';
	switch (change.action) {
		case 'invite':
			return change.role === 'owner' && !actorIsOwner ? 'Only owners can invite another owner.' : undefined;
		case 'update-role':
			if (change.role === change.targetRole) return 'That member already has this role.';
			if ((change.targetRole === 'owner' || change.role === 'owner') && !actorIsOwner)
				return 'Only owners can grant or change the owner role.';
			if (change.targetRole === 'owner' && ownerCount <= 1)
				return 'An organisation needs at least one owner. Make someone else an owner first.';
			return undefined;
		case 'remove':
			if (change.self) return 'You cannot remove yourself from the organisation here.';
			if (change.targetRole === 'owner' && !actorIsOwner) return 'Only owners can remove an owner.';
			if (change.targetRole === 'owner' && ownerCount <= 1)
				return 'An organisation needs at least one owner. Make someone else an owner first.';
			return undefined;
	}
}

/** Organisation slugs: lowercase letters, digits and single hyphens, 2–48 characters. */
const ORG_SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,47}$/;

/**
 * Rename the principal's organisation (Settings → General). Owners and admins only, from an
 * interactive session: Better Auth grants both `organization:update`. The slug is display-only
 * today (no URL or content hostname is derived from it), so changing it moves nothing.
 */
export function renameOrganization(
	sqlite: Database,
	principal: Principal,
	input: { name: string; slug: string },
): { name: string; slug: string } {
	if (principal.credential !== 'session' || !principal.permissions.has('org:update'))
		throw new ForbiddenError('Only an owner or admin can rename the organisation.');
	const name = input.name.trim().replace(/\s+/g, ' ');
	const slug = input.slug.trim().toLowerCase();
	if (name.length < 1 || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name))
		throw new ValidationError('The name must be 1–64 characters.');
	if (!ORG_SLUG.test(slug))
		throw new ValidationError('The slug must be 2–48 lowercase letters, digits or single hyphens.');
	const taken = sqlite
		.query<{ id: string }, [string, string]>('SELECT id FROM organization WHERE slug = ? AND id != ?')
		.get(slug, principal.orgId);
	if (taken) throw new ConflictError(`The slug "${slug}" is already used by another organisation.`);
	sqlite.run('UPDATE organization SET name = ?, slug = ? WHERE id = ?', [name, slug, principal.orgId]);
	return { name, slug };
}

import type { Role } from '@skiff/contracts';
import { isRole } from '@skiff/core';
import { sqlite } from './db';

/**
 * Organisation membership lookups for multi-org sessions (IAM.md I5, §8.1). Better Auth owns the
 * `member` and `session` rows; everything here is a read of them, plus the one `user` preference
 * that remembers where the caller last worked so the next sign-in starts there.
 */
export interface OrgMembership {
	id: string;
	name: string;
	slug: string;
	role: Role;
}

/** Every org the caller belongs to, oldest membership first. */
export function listMemberships(userId: string): OrgMembership[] {
	try {
		return sqlite
			.query<{ id: string; name: string; slug: string; role: string }, [string]>(
				`SELECT o.id, o.name, o.slug, m.role
				   FROM member m
				   JOIN organization o ON o.id = m.organizationId
				  WHERE m.userId = ?
				  ORDER BY m.createdAt ASC`
			)
			.all(userId)
			.map((row) => ({
				id: row.id,
				name: row.name,
				slug: row.slug,
				role: isRole(row.role) ? row.role : 'viewer'
			}));
	} catch {
		// Auth tables are not present yet (unit tests / bootstrapping).
		return [];
	}
}

/** The caller's role in one specific org; `undefined` when they are not a member of it. */
export function membershipRoleIn(orgId: string, userId: string): Role | undefined {
	try {
		const row = sqlite
			.query<{ role: string }, [string, string]>(
				'SELECT role FROM member WHERE organizationId = ? AND userId = ? LIMIT 1'
			)
			.get(orgId, userId);
		if (!row) return undefined;
		return isRole(row.role) ? row.role : 'viewer';
	} catch {
		return undefined;
	}
}

/**
 * The org a new session starts in: the one the caller last used (remembered on the user row), else
 * their first membership. `undefined` for a user with no membership yet, such as an invitee who
 * has not accepted (IAM.md §8.2).
 */
export function preferredOrganizationId(userId: string): string | undefined {
	try {
		const preferred = sqlite
			.query<{ orgId: string }, [string]>(
				`SELECT m.organizationId AS orgId
				   FROM user u
				   JOIN member m ON m.userId = u.id AND m.organizationId = u.lastOrganizationId
				  WHERE u.id = ?
				  LIMIT 1`
			)
			.get(userId);
		if (preferred) return preferred.orgId;
	} catch {
		// The preference column may not exist yet on an install that has not migrated.
	}
	try {
		return sqlite
			.query<{ orgId: string }, [string]>(
				'SELECT organizationId AS orgId FROM member WHERE userId = ? ORDER BY createdAt ASC LIMIT 1'
			)
			.get(userId)?.orgId;
	} catch {
		return undefined;
	}
}

/** Remember where the caller last worked, so their next sign-in starts there. */
export function rememberOrganization(userId: string, orgId: string): void {
	try {
		sqlite.run('UPDATE user SET lastOrganizationId = ? WHERE id = ?', [orgId, userId]);
	} catch {
		// The preference is an optimisation, never an authorisation gate.
	}
}

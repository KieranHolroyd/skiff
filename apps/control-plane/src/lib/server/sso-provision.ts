/**
 * JIT provisioning for SSO sign-ins (IAM.md I19, §8.3, I21).
 *
 * Better Auth's `@better-auth/sso` plugin creates the user and session. Organisation provisioning
 * in the plugin is disabled, because Skiff owns memberships, the default role and (later) group
 * mapping. This callback runs once per new SSO user, in the same request as the callback:
 *
 * - add a `member` row for the provider's organisation;
 * - the default role is `viewer`, or no membership at all when `SKIFF_SSO_DEFAULT_ROLE=none`;
 * - make that org the new session's active org, because the session was created before the member
 *   row existed.
 *
 * Group mapping and SCIM are deliberately not here yet: the IdP groups claim is copied into the
 * plugin provider's `mapping.extraFields` for the future `sso_group_mappings` work, but no roles are
 * derived from it.
 *
 * TODO(I19): read the groups claim from `provisionUser`'s `userInfo`, map `sso_group_mappings` to
 * `iam_groups`, and assign bindings instead of the flat default role.
 * TODO(I20): SCIM user/group provisioning and deprovisioning (Better Auth `scim` plugin).
 */
import type { Principal } from '@skiff/contracts';
import { newId } from '@skiff/core';
import { rememberOrganization } from './org-membership';
import { sqlite } from './db';
import { core } from './core';

/** The role a just-provisioned SSO member gets. `none` leaves them without org access. */
export type SsoDefaultRole = 'viewer' | 'none';

const configuredRole = process.env.SKIFF_SSO_DEFAULT_ROLE?.trim().toLowerCase();

export const ssoDefaultRole: SsoDefaultRole = configuredRole === 'none' ? 'none' : 'viewer';

interface SsoUser {
	id: string;
	email?: string;
}

interface SsoProviderRef {
	providerId: string;
	organizationId?: string | null;
	issuer?: string;
}

function systemPrincipal(orgId: string): Principal {
	return {
		kind: 'system',
		userId: 'system:sso',
		orgId,
		role: 'owner',
		permissions: new Set(),
	};
}

/**
 * Create the member row and point the session at the org. Idempotent: an existing member is left
 * alone, so a replayed callback or a user who was invited first keeps their role.
 */
export function provisionSsoUser(input: {
	user: SsoUser;
	provider: SsoProviderRef;
}): void {
	const orgId = input.provider.organizationId;
	if (!orgId) return;
	const actor = systemPrincipal(orgId);
	try {
		if (ssoDefaultRole === 'none') {
			core.ctx.audit.record({
				principal: actor,
				action: 'sso.jit.skipped',
				resource: 'member',
				resourceId: input.user.id,
				args: {
					orgId,
					providerId: input.provider.providerId,
					reason: 'SKIFF_SSO_DEFAULT_ROLE=none',
				},
				result: 'ok',
			});
			return;
		}

		const existing = sqlite
			.query<{ id: string; role: string }, [string, string]>(
				'SELECT id, role FROM member WHERE organizationId = ? AND userId = ?'
			)
			.get(orgId, input.user.id);
		if (!existing) {
			sqlite.run(
				`INSERT INTO member (id, organizationId, userId, role, createdAt)
				 VALUES (?, ?, ?, ?, ?)`,
				[newId('mem_'), orgId, input.user.id, ssoDefaultRole, new Date().toISOString()]
			);
			// Give the engine the base-role binding immediately, so the first request after the
			// callback sees the same access as any other member.
			core.iam.syncMembers(orgId);
		}

		rememberOrganization(input.user.id, orgId);
		// The session was created before this callback, so its organization hook had no membership
		// to prefer. Point the newest session at the org the IdP just proved.
		sqlite.run(
			`UPDATE session SET activeOrganizationId = ?
			 WHERE id = (SELECT id FROM session WHERE userId = ? ORDER BY createdAt DESC LIMIT 1)`,
			[orgId, input.user.id]
		);

		core.ctx.audit.record({
			principal: actor,
			action: existing ? 'sso.jit.existing' : 'sso.jit.provision',
			resource: 'member',
			resourceId: input.user.id,
			args: {
				orgId,
				providerId: input.provider.providerId,
				issuer: input.provider.issuer ?? null,
				email: input.user.email ?? null,
				role: existing?.role ?? ssoDefaultRole,
			},
			result: 'ok',
		});
	} catch (error) {
		// Never turn a successful authentication into a 500: the session exists, and an operator can
		// add the membership from Settings → Members. The failure is still audited.
		console.error('[sso] JIT provisioning failed:', error);
		try {
			core.ctx.audit.record({
				principal: actor,
				action: 'sso.jit.provision',
				resource: 'member',
				resourceId: input.user.id,
				args: { orgId, providerId: input.provider.providerId },
				result: 'error',
				error: (error as Error).message,
			});
		} catch {
			// A broken audit table must not take sign-in down either.
		}
	}
}

/**
 * JIT provisioning for SSO sign-ins (IAM.md I19, §8.3, I21).
 *
 * Better Auth's `@better-auth/sso` plugin creates the user and session. Organisation provisioning
 * in the plugin is disabled, because Yoal owns memberships, the default role and group mapping.
 * This callback runs on every sign-in (`provisionUserOnEveryLogin`), because IdP group membership
 * changes between sign-ins and roles follow the directory:
 *
 * - add a `member` row for the provider's organisation if the user is not one yet;
 * - the default role is `viewer`, or no membership at all when `YOAL_SSO_DEFAULT_ROLE=none`
 *   (unless a group mapping applies, since then the group binding is the point);
 * - map the provider's groups claim through `sso_group_mappings` and replace the user's
 *   `source = 'sso'` group membership. Local membership rows and `source = 'scim'` rows are never
 *   touched;
 * - make that org the new session's active org, because the session may have been created before
 *   the member row existed.
 *
 * A missing groups claim (`undefined`) leaves the last synced membership alone. An empty claim
 * (`[]`) is a real assertion that the user is in no IdP groups and clears the synced membership.
 */
import type { Principal } from '@yoal/contracts';
import { groupClaimValues, groupIdsForClaims, newId } from '@yoal/core';
import { rememberOrganization } from './org-membership';
import { sqlite } from './db';
import { core } from './core';

/** The role a just-provisioned SSO member gets. `none` leaves them without org access. */
export type SsoDefaultRole = 'viewer' | 'none';

const configuredRole = process.env.YOAL_SSO_DEFAULT_ROLE?.trim().toLowerCase();

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
		permissions: new Set()
	};
}

/** The provider's configured groups claim and the org's mappings, resolved once per sign-in. */
function mappedGroupIds(
	orgId: string,
	providerId: string,
	userInfo: Record<string, unknown> | undefined
): {
	groups: string[] | undefined;
	groupIds: string[];
} {
	const provider = sqlite
		.query<{ claim_groups: string }, [string, string]>(
			'SELECT claim_groups FROM sso_providers WHERE org_id = ? AND id = ?'
		)
		.get(orgId, providerId);
	if (!provider) return { groups: undefined, groupIds: [] };
	// The plugin normalises both OIDC extra fields and SAML attributes under the canonical
	// `groups` key (sso-sync.ts maps the provider's claim there), so prefer it and fall back to
	// the raw claim name for older provider rows or a plugin that passes attributes through.
	const rawGroups =
		userInfo?.groups !== undefined ? userInfo.groups : userInfo?.[provider.claim_groups];
	const groups = userInfo ? groupClaimValues(rawGroups) : undefined;
	if (groups === undefined) return { groups, groupIds: [] };
	let mappings: Array<{ claimValue: string; groupId: string }> = [];
	try {
		mappings = sqlite
			.query<{ claim_value: string; group_id: string }, [string, string]>(
				`SELECT m.claim_value, m.group_id
				 FROM sso_group_mappings m
				 JOIN iam_groups g ON g.id = m.group_id AND g.org_id = m.org_id
				 WHERE m.org_id = ? AND m.provider_id = ?`
			)
			.all(orgId, providerId)
			.map((row) => ({ claimValue: row.claim_value, groupId: row.group_id }));
	} catch (error) {
		// A build without the mapping migration must still sign the user in with the default role.
		if (!String(error).includes('no such table')) throw error;
	}
	return { groups, groupIds: groupIdsForClaims(groups, mappings) };
}

/**
 * Replace the IdP-sourced half of a user's group membership. A local membership for the same
 * group wins (the primary key already makes that row unique), and `source = 'scim'` rows are
 * owned by the SCIM reconciler.
 */
function syncSsoGroups(
	orgId: string,
	userId: string,
	providerId: string,
	groups: string[] | undefined,
	groupIds: string[]
): void {
	if (groups === undefined) return;
	const now = core.ctx.now();
	sqlite.transaction(() => {
		sqlite.run(
			`DELETE FROM iam_group_members
			 WHERE user_id = ? AND source = 'sso'
			   AND group_id IN (SELECT id FROM iam_groups WHERE org_id = ?)`,
			[userId, orgId]
		);
		for (const groupId of groupIds)
			sqlite.run(
				`INSERT INTO iam_group_members (group_id, user_id, source, created_at)
				 VALUES (?, ?, 'sso', ?) ON CONFLICT (group_id, user_id) DO NOTHING`,
				[groupId, userId, now]
			);
		// Group membership changes the compiled grants, so the IAM version must move.
		core.iam.touch(orgId);
	})();
	core.ctx.audit.record({
		principal: systemPrincipal(orgId),
		action: 'sso.groups.sync',
		resource: 'member',
		resourceId: userId,
		args: { orgId, providerId, claims: groups, groupIds },
		result: 'ok'
	});
}

/**
 * Create the member row and point the session at the org. Idempotent: an existing member is left
 * alone, so a replayed callback or a user who was invited first keeps their role.
 */
export function provisionSsoUser(input: {
	user: SsoUser;
	provider: SsoProviderRef;
	userInfo?: Record<string, unknown>;
}): void {
	const orgId = input.provider.organizationId;
	if (!orgId) return;
	const actor = systemPrincipal(orgId);
	try {
		const { groups, groupIds } = mappedGroupIds(orgId, input.provider.providerId, input.userInfo);

		if (ssoDefaultRole === 'none' && groupIds.length === 0) {
			core.ctx.audit.record({
				principal: actor,
				action: 'sso.jit.skipped',
				resource: 'member',
				resourceId: input.user.id,
				args: {
					orgId,
					providerId: input.provider.providerId,
					reason: 'YOAL_SSO_DEFAULT_ROLE=none'
				},
				result: 'ok'
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
				[
					newId('mem_'),
					orgId,
					input.user.id,
					ssoDefaultRole === 'none' ? 'viewer' : ssoDefaultRole,
					new Date().toISOString()
				]
			);
			// Give the engine the base-role binding immediately, so the first request after the
			// callback sees the same access as any other member.
			core.iam.syncMembers(orgId);
		}

		syncSsoGroups(orgId, input.user.id, input.provider.providerId, groups, groupIds);

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
				groups: groups ?? null,
				groupIds
			},
			result: 'ok'
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
				error: (error as Error).message
			});
		} catch {
			// A broken audit table must not take sign-in down either.
		}
	}
}

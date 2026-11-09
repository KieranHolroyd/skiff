/**
 * SCIM 2.0 credentials and directory reconciliation (IAM.md I20, §8.4).
 *
 * The SCIM protocol itself is served by Better Auth's `@better-auth/scim` plugin at
 * `/api/auth/scim/v2`. The plugin owns its boot-migrated resource tables but deliberately has no
 * organisation model: this service supplies the missing Skiff pieces.
 *
 * - `ScimTokenService` mints the per-organisation bearer token. Only `sha256(raw)` is stored, and
 *   the raw value is returned once, when it is created. `verify` is the plugin's
 *   `authentication.verifyBearerToken` hook.
 * - `syncFromScim` runs after every SCIM request (the control plane calls it from an auth hook).
 *   It turns provisioned users into org members with the default role, disables deactivated users
 *   and revokes everything they held, and mirrors SCIM groups into `iam_groups` with
 *   `source = 'scim'` and membership `source = 'scim'`. Because the SCIM group is authoritative,
 *   the dashboard must not edit that membership (`IamService.addGroupMember` already refuses).
 *
 * The plugin stays the protocol implementation; this module is the Skiff behavioural layer.
 */
import type { Database } from 'bun:sqlite';
import type { Principal } from '@skiff/contracts';
import type { CoreContext } from '../context.ts';
import { NotFoundError } from '../errors.ts';
import { newId, randomToken, sha256Hex } from '../util.ts';

/** The visible prefix of every SCIM bearer token. */
export const SCIM_TOKEN_PREFIX = 'scim_';

/** `last_used_at` is written at most this often per token. */
const TOKEN_TOUCH_INTERVAL_MS = 60_000;

/** The role a SCIM-provisioned user gets when they become an org member. */
export const SCIM_DEFAULT_ROLE = 'viewer';

export interface ScimTokenView {
	id: string;
	orgId: string;
	createdBy: string;
	createdAt: number;
	lastUsedAt: number | null;
	revokedAt: number | null;
}

export interface ScimTokenVerification {
	tokenId: string;
	orgId: string;
}

interface ScimTokenRow {
	id: string;
	org_id: string;
	token_hash: string;
	created_by: string;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
}

/**
 * The stored form of a SCIM bearer token. A deterministic hash is enough for a high-entropy
 * random credential: verification is a single indexed lookup, and a database leak cannot recover
 * the token. Exported so the control plane and tests hash exactly the same way.
 */
export function hashScimToken(raw: string): string {
	return sha256Hex(raw.trim());
}

/** A token is `scim_` plus 32 random bytes (base64url), matching access-key style. */
export function mintScimToken(): string {
	return `${SCIM_TOKEN_PREFIX}${randomToken(32)}`;
}

function view(row: ScimTokenRow): ScimTokenView {
	return {
		id: row.id,
		orgId: row.org_id,
		createdBy: row.created_by,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
		revokedAt: row.revoked_at
	};
}

/** The plugin tables exist only after Better Auth's boot migration; a missing one is not an error. */
function tableExists(sqlite: Database, name: string): boolean {
	const row = sqlite
		.query<{ name: string }, [string]>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
		)
		.get(name);
	return Boolean(row);
}

interface ScimUserRow {
	id: string;
	provisioningDomainId: string;
	userId: string;
	active: number | boolean;
}

interface ScimGroupRow {
	id: string;
	provisioningDomainId: string;
	displayName: string;
	externalId: string | null;
}

interface ScimGroupMemberRow {
	groupId: string;
	scimUserId: string;
}

interface IamGroupRow {
	id: string;
	org_id: string;
	name: string;
	source: string;
	external_id: string | null;
}

interface MemberRow {
	id: string;
	role: string;
}

export class ScimTokenService {
	readonly #sqlite: Database;

	constructor(private readonly ctx: CoreContext) {
		this.#sqlite = ctx.sqlite;
	}

	#requireRead(principal: Principal): void {
		this.ctx.iam.require(principal, 'sso:read', { type: 'org' });
	}

	#requireManage(principal: Principal): void {
		this.ctx.iam.require(principal, 'sso:manage', { type: 'org' });
	}

	#row(orgId: string, id: string): ScimTokenRow {
		const row = this.#sqlite
			.query<ScimTokenRow, [string, string]>(
				'SELECT * FROM scim_tokens WHERE org_id = ? AND id = ?'
			)
			.get(orgId, id);
		if (!row) throw new NotFoundError('SCIM token');
		return row;
	}

	/** Tokens for Settings → SSO. Hashes and raw values never appear in the view. */
	list(principal: Principal): ScimTokenView[] {
		this.#requireRead(principal);
		try {
			return this.#sqlite
				.query<ScimTokenRow, [string]>(
					'SELECT * FROM scim_tokens WHERE org_id = ? ORDER BY created_at DESC'
				)
				.all(principal.orgId)
				.map(view);
		} catch (error) {
			// A build whose migration has not been embedded yet still renders Settings → SSO.
			if (String(error).includes('no such table')) return [];
			throw error;
		}
	}

	/**
	 * Mint a token and return it exactly once. `rotate` revokes the organisation's active tokens
	 * first, which is the common case when a directory connection is replaced.
	 */
	create(principal: Principal): { token: string; scimToken: ScimTokenView } {
		this.#requireManage(principal);
		const token = mintScimToken();
		const id = newId('scimt_');
		const now = this.ctx.now();
		this.#sqlite.run(
			`INSERT INTO scim_tokens (id, org_id, token_hash, created_by, created_at, last_used_at, revoked_at)
			 VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
			[id, principal.orgId, hashScimToken(token), principal.userId, now]
		);
		this.ctx.audit.record({
			principal,
			action: 'scim.token.create',
			resource: 'scim_token',
			resourceId: id,
			args: { orgId: principal.orgId },
			result: 'ok'
		});
		return { token, scimToken: view(this.#row(principal.orgId, id)) };
	}

	/** Revoke every active token and mint one replacement, returned once. */
	rotate(principal: Principal): { token: string; scimToken: ScimTokenView } {
		this.#requireManage(principal);
		const now = this.ctx.now();
		this.#sqlite.transaction(() => {
			this.#sqlite.run(
				'UPDATE scim_tokens SET revoked_at = ? WHERE org_id = ? AND revoked_at IS NULL',
				[now, principal.orgId]
			);
		})();
		this.ctx.audit.record({
			principal,
			action: 'scim.token.rotate',
			resource: 'scim_token',
			resourceId: principal.orgId,
			args: { orgId: principal.orgId },
			result: 'ok'
		});
		return this.create(principal);
	}

	revoke(principal: Principal, id: string): ScimTokenView {
		this.#requireManage(principal);
		const row = this.#row(principal.orgId, id);
		if (row.revoked_at !== null) return view(row);
		const now = this.ctx.now();
		this.#sqlite.run('UPDATE scim_tokens SET revoked_at = ? WHERE id = ?', [now, id]);
		this.ctx.audit.record({
			principal,
			action: 'scim.token.revoke',
			resource: 'scim_token',
			resourceId: id,
			args: { orgId: principal.orgId },
			result: 'ok'
		});
		return view({ ...row, revoked_at: now });
	}

	/**
	 * Verify a bearer token from the SCIM endpoint. Returns the organisation it belongs to, or
	 * null for an unknown, revoked or malformed value. A successful use records `last_used_at` at
	 * most once a minute.
	 */
	verify(raw: string): ScimTokenVerification | null {
		const token = raw.trim();
		if (!token.startsWith(SCIM_TOKEN_PREFIX)) return null;
		let row: ScimTokenRow | null;
		try {
			row = this.#sqlite
				.query<ScimTokenRow, [string]>('SELECT * FROM scim_tokens WHERE token_hash = ?')
				.get(hashScimToken(token));
		} catch (error) {
			if (String(error).includes('no such table')) return null;
			throw error;
		}
		if (!row || row.revoked_at !== null) return null;
		const now = this.ctx.now();
		if (row.last_used_at === null || now - row.last_used_at >= TOKEN_TOUCH_INTERVAL_MS)
			this.#sqlite.run('UPDATE scim_tokens SET last_used_at = ? WHERE id = ?', [now, row.id]);
		return { tokenId: row.id, orgId: row.org_id };
	}

	// ---------------------------------------------------------------- directory reconciliation

	/**
	 * Apply what the SCIM plugin just persisted. Called after every `/scim/v2` request. It is
	 * idempotent: every statement is an upsert or a delete of rows that are no longer current.
	 */
	syncFromScim(): { users: number; groups: number } {
		if (!tableExists(this.#sqlite, 'scimUser')) return { users: 0, groups: 0 };
		const users = this.#syncUsers();
		const groups = this.#syncGroups();
		return { users, groups };
	}

	#syncUsers(): number {
		if (!tableExists(this.#sqlite, 'user') || !tableExists(this.#sqlite, 'member')) return 0;
		const rows = this.#sqlite
			.query<ScimUserRow, []>(`SELECT id, provisioningDomainId, userId, active FROM "scimUser"`)
			.all();
		let changed = 0;
		const activeUsers = new Set<string>();
		for (const row of rows) {
			const orgId = row.provisioningDomainId;
			if (!orgId) continue;
			const active = row.active === true || row.active === 1;
			if (active) {
				activeUsers.add(row.userId);
				changed += this.#activateUser(row.userId, orgId);
			} else changed += this.#deactivateUser(row.userId, orgId);
		}

		// `DELETE /Users/:id` removes the SCIM resource and leaves a tombstone. The person is
		// still a Better Auth user, so their access must be revoked exactly like a PATCH
		// `active: false`. A re-created SCIM user consumes its tombstone, so it is not here.
		if (tableExists(this.#sqlite, 'scimIdentityTombstone')) {
			const tombstones = this.#sqlite
				.query<{ userId: string; provisioningDomainId: string }, []>(
					'SELECT userId, provisioningDomainId FROM "scimIdentityTombstone"'
				)
				.all();
			for (const row of tombstones) {
				if (activeUsers.has(row.userId)) continue;
				if (row.provisioningDomainId)
					changed += this.#deactivateUser(row.userId, row.provisioningDomainId);
			}
		}
		return changed > 0 ? 1 : 0;
	}

	#activateUser(userId: string, orgId: string): number {
		const user = this.#sqlite
			.query<{ id: string; banned: number | null }, [string]>(
				'SELECT id, banned FROM user WHERE id = ?'
			)
			.get(userId);
		if (!user) return 0;
		let changed = 0;
		const now = this.ctx.now();
		const existing = this.#sqlite
			.query<MemberRow, [string, string]>(
				'SELECT id, role FROM member WHERE organizationId = ? AND userId = ?'
			)
			.get(orgId, userId);
		if (!existing) {
			this.#sqlite.run(
				`INSERT INTO member (id, organizationId, userId, role, createdAt)
				 VALUES (?, ?, ?, ?, ?)`,
				[newId('mem_'), orgId, userId, SCIM_DEFAULT_ROLE, new Date(now).toISOString()]
			);
			// Give the engine the base-role binding immediately.
			this.ctx.iam.syncMembers(orgId);
			this.#auditSystem(orgId, 'scim.user.provision', userId, {
				role: SCIM_DEFAULT_ROLE
			});
			changed += 1;
		}
		if (user.banned === 1) {
			this.#sqlite.run('UPDATE user SET banned = 0, banReason = NULL WHERE id = ?', [userId]);
			this.#auditSystem(orgId, 'scim.user.reactivate', userId, {});
			changed += 1;
		}
		return changed;
	}

	/**
	 * Deactivation is immediate and total (IAM.md §8.4): remove sessions, OAuth grants and the
	 * user's own access keys. Service-account keys are untouched because they belong to a
	 * different principal. The member row is kept so reactivation restores the same org.
	 */
	#deactivateUser(userId: string, orgId: string): number {
		const user = this.#sqlite
			.query<{ id: string; banned: number | null }, [string]>(
				'SELECT id, banned FROM user WHERE id = ?'
			)
			.get(userId);
		if (!user || user.banned === 1) return 0;
		const now = this.ctx.now();
		this.#sqlite.transaction(() => {
			this.#deleteIfPresent('session', 'DELETE FROM session WHERE userId = ?', [userId]);
			// Better Auth's MCP OAuth provider owns these tables.
			this.#deleteIfPresent('oauthAccessToken', 'DELETE FROM oauthAccessToken WHERE userId = ?', [
				userId
			]);
			this.#deleteIfPresent('oauthRefreshToken', 'DELETE FROM oauthRefreshToken WHERE userId = ?', [
				userId
			]);
			this.#deleteIfPresent('oauthConsent', 'DELETE FROM oauthConsent WHERE userId = ?', [userId]);
			this.#deleteIfPresent(
				'oauth_client_usage',
				'DELETE FROM oauth_client_usage WHERE user_id = ?',
				[userId]
			);
			this.#sqlite.run(
				"UPDATE user SET banned = 1, banReason = 'Deactivated by SCIM' WHERE id = ?",
				[userId]
			);
		})();

		// Revoke the user's own keys through the service, so the access-key audit trail is kept.
		// (Better Auth's session and OAuth tables are deleted in the transaction above; a direct
		// delete is used because this reconciler runs outside a Better Auth request.)
		const actor: Principal = {
			kind: 'system',
			userId: 'system:scim',
			orgId,
			role: 'owner',
			permissions: new Set(['accessKey:read-all', 'accessKey:revoke-any'])
		};
		try {
			for (const key of this.ctx.accessKeys.list(actor, {
				principalId: userId
			}))
				if (key.revokedAt === null) this.ctx.accessKeys.revoke(actor, key.id);
		} catch (error) {
			// A missing access-keys table must not stop the rest of deprovisioning.
			console.error('[scim] could not revoke access keys for', userId, error);
		}
		this.#auditSystem(orgId, 'scim.user.deactivate', userId, { at: now });
		return 1;
	}

	#deleteIfPresent(table: string, sql: string, args: [string]): void {
		if (!tableExists(this.#sqlite, table)) return;
		this.#sqlite.run(sql, args);
	}

	/**
	 * Mirror the plugin's groups. SCIM is authoritative for groups with `source = 'scim'`:
	 * renames follow the claim, removed groups disappear, and membership is reconciled on each
	 * sync. Local membership rows for the same pair are never deleted.
	 */
	#syncGroups(): number {
		if (
			!tableExists(this.#sqlite, 'scimGroup') ||
			!tableExists(this.#sqlite, 'scimGroupMember') ||
			!tableExists(this.#sqlite, 'scimUser') ||
			!tableExists(this.#sqlite, 'iam_groups')
		)
			return 0;
		const groups = this.#sqlite
			.query<ScimGroupRow, []>(
				`SELECT id, provisioningDomainId, displayName, externalId FROM "scimGroup"`
			)
			.all();
		const memberships = this.#sqlite
			.query<ScimGroupMemberRow, []>(`SELECT groupId, scimUserId FROM "scimGroupMember"`)
			.all();
		const scimUsers = new Map(
			this.#sqlite
				.query<{ id: string; userId: string }, []>('SELECT id, userId FROM "scimUser"')
				.all()
				.map((row) => [row.id, row.userId] as const)
		);

		const membersByGroup = new Map<string, string[]>();
		for (const row of memberships) {
			const userId = scimUsers.get(row.scimUserId);
			if (!userId) continue;
			const list = membersByGroup.get(row.groupId) ?? [];
			list.push(userId);
			membersByGroup.set(row.groupId, list);
		}

		let changed = 0;
		const touchedOrgs = new Set<string>();
		const seenByOrg = new Map<string, Set<string>>();
		for (const group of groups) {
			const orgId = group.provisioningDomainId;
			if (!orgId) continue;
			// Prefer the directory's own id: it survives the plugin recreating its row.
			const externalId = group.externalId?.trim() || group.id;
			const seen = seenByOrg.get(orgId) ?? new Set<string>();
			seen.add(externalId);
			seenByOrg.set(orgId, seen);

			const existing = this.#sqlite
				.query<IamGroupRow, [string, string]>(
					`SELECT id, org_id, name, source, external_id FROM iam_groups
					 WHERE org_id = ? AND source = 'scim' AND external_id = ?`
				)
				.get(orgId, externalId);
			const name = this.#uniqueGroupName(orgId, group.displayName, existing?.id ?? null);
			let groupId = existing?.id;
			if (!groupId) {
				groupId = newId('grp_');
				this.#sqlite.run(
					`INSERT INTO iam_groups (id, org_id, name, description, source, external_id, created_by, created_at, updated_at)
					 VALUES (?, ?, ?, ?, 'scim', ?, 'system:scim', ?, ?)`,
					[groupId, orgId, name, 'Managed by SCIM', externalId, this.ctx.now(), this.ctx.now()]
				);
				changed += 1;
			} else if (existing!.name !== name) {
				this.#sqlite.run('UPDATE iam_groups SET name = ?, updated_at = ? WHERE id = ?', [
					name,
					this.ctx.now(),
					groupId
				]);
				changed += 1;
			}

			// Reconcile only SCIM-sourced membership. A human-added local row survives, and the
			// composite primary key means an explicit local grant wins over the directory.
			const desired = new Set(
				(membersByGroup.get(group.id) ?? []).filter((userId) =>
					Boolean(
						this.#sqlite
							.query<{ id: string }, [string, string]>(
								'SELECT id FROM member WHERE organizationId = ? AND userId = ?'
							)
							.get(orgId, userId)
					)
				)
			);
			const current = new Set(
				this.#sqlite
					.query<{ user_id: string }, [string]>(
						"SELECT user_id FROM iam_group_members WHERE group_id = ? AND source = 'scim'"
					)
					.all(groupId)
					.map((row) => row.user_id)
			);
			const same =
				current.size === desired.size && [...desired].every((userId) => current.has(userId));
			if (!same) {
				this.#sqlite.run("DELETE FROM iam_group_members WHERE group_id = ? AND source = 'scim'", [
					groupId
				]);
				for (const userId of desired)
					this.#sqlite.run(
						`INSERT INTO iam_group_members (group_id, user_id, source, created_at)
						 VALUES (?, ?, 'scim', ?) ON CONFLICT (group_id, user_id) DO NOTHING`,
						[groupId, userId, this.ctx.now()]
					);
				changed += 1;
				touchedOrgs.add(orgId);
			}
		}

		// Groups deleted at the IdP: remove the mirror for every org that has ever had a token.
		const tokenOrgs = this.#sqlite
			.query<{ org_id: string }, []>('SELECT DISTINCT org_id FROM scim_tokens')
			.all();
		for (const { org_id: orgId } of tokenOrgs) {
			const seen = seenByOrg.get(orgId) ?? new Set<string>();
			const stale = this.#sqlite
				.query<{ id: string; external_id: string | null }, [string]>(
					"SELECT id, external_id FROM iam_groups WHERE org_id = ? AND source = 'scim'"
				)
				.all(orgId)
				.filter((row) => !seen.has(row.external_id ?? ''));
			for (const row of stale) {
				this.#sqlite.run('DELETE FROM iam_group_members WHERE group_id = ?', [row.id]);
				this.#sqlite.run('DELETE FROM iam_groups WHERE id = ?', [row.id]);
				changed += 1;
			}
			if (stale.length > 0) touchedOrgs.add(orgId);
		}

		for (const orgId of touchedOrgs) {
			this.ctx.iam.touch(orgId);
			if (changed > 0)
				this.#auditSystem(orgId, 'scim.groups.sync', orgId, {
					groups: groups.filter((group) => group.provisioningDomainId === orgId).length
				});
		}
		return changed;
	}

	/** SCIM display names are not constrained like Skiff group names; guarantee uniqueness. */
	#uniqueGroupName(orgId: string, raw: string, ownId: string | null): string {
		const base = raw.trim().slice(0, 80) || 'SCIM group';
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const candidate = attempt === 0 ? base : `${base} (${attempt + 1})`;
			const taken = this.#sqlite
				.query<{ id: string }, [string, string]>(
					'SELECT id FROM iam_groups WHERE org_id = ? AND name = ?'
				)
				.get(orgId, candidate);
			if (!taken || taken.id === ownId) return candidate;
		}
		return `${base} (${newId().slice(0, 6)})`;
	}

	#auditSystem(
		orgId: string,
		action: string,
		resourceId: string,
		args: Record<string, unknown>
	): void {
		try {
			this.ctx.audit.record({
				principal: {
					kind: 'system',
					userId: 'system:scim',
					orgId,
					role: 'owner',
					permissions: new Set(['sso:manage'])
				},
				action,
				resource: 'scim_user',
				resourceId,
				args,
				result: 'ok'
			});
		} catch (error) {
			console.error(`[scim] could not audit ${action}:`, error);
		}
	}
}

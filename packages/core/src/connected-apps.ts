import type { Principal } from '@yoal/contracts';
import { requirePermission } from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError, NotFoundError } from './errors.ts';

/**
 * Connected apps: the MCP/OAuth clients a user has approved (Settings → Connected apps).
 *
 * Better Auth's OAuth provider owns the grant: one `oauthConsent` row per (user, client) with the
 * approved scopes, plus `oauthRefreshToken` rows. Access tokens for `/mcp` are audience-bound JWTs
 * that the database never sees, so deleting rows alone would leave a live token working until it
 * expires (an hour). `/mcp` therefore asks `grantActive` on every call: a token is honoured only
 * while a consent for its (user, client) exists that is no newer than the token. Revoking deletes
 * the consent and the refresh tokens, so the next call fails with a fresh OAuth challenge and the
 * client must send the user through consent again.
 *
 * Anyone may list and revoke their own grants. Seeing and revoking other members' grants in the
 * organisation takes `member:remove` (owners and admins), and only an owner can revoke an owner's.
 */

/** The permission that lets someone manage other members' connected apps. */
export const CONNECTED_APPS_ORG_PERMISSION = 'member:remove' as const;

/** `/mcp` records use at most this often per (user, client). */
const TOUCH_INTERVAL_MS = 60_000;

export interface ConnectedApp {
	/** The grant (Better Auth consent) id. */
	id: string;
	clientId: string;
	/** The name the client registered or published; null when it gave none. */
	name: string | null;
	uri: string | null;
	icon: string | null;
	/** `metadata-document` when the client id is a CIMD URL, `registered` for DCR clients. */
	registration: 'metadata-document' | 'registered';
	/** Approved scopes, identity scopes (`openid`, `offline_access`, …) included. */
	scopes: string[];
	createdAt: number;
	updatedAt: number;
	/** Last MCP call, else the last token refresh; null if neither is known. */
	lastUsedAt: number | null;
	/** Refresh tokens that can still mint new access tokens. */
	activeRefreshTokens: number;
	user: { id: string; name: string | null; email: string | null; role: string | null };
}

interface GrantRow {
	id: string;
	clientId: string;
	userId: string;
	scopes: string | null;
	createdAt: string | number | null;
	updatedAt: string | number | null;
	name: string | null;
	uri: string | null;
	icon: string | null;
	userName: string | null;
	userEmail: string | null;
	memberRole: string | null;
	lastUsedAt: number | null;
	lastRefreshAt: string | number | null;
	activeRefreshTokens: number;
}

/** Better Auth's SQLite adapter stores dates as ISO-8601 text; tolerate epoch numbers too. */
export function authDate(value: string | number | null | undefined): number | null {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	const numeric = Number(value);
	if (Number.isFinite(numeric) && /^\d+$/.test(value)) return numeric;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Better Auth stores `string[]` columns as JSON text (older rows: comma or space separated). */
export function authList(value: string | null | undefined): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === 'string');
	} catch {
		// fall through
	}
	return value.split(/[\s,]+/).filter(Boolean);
}

function isMissingTable(error: unknown): boolean {
	return error instanceof Error && /no such table/i.test(error.message);
}

export class ConnectedAppService {
	private readonly touched = new Map<string, number>();

	constructor(private readonly ctx: CoreContext) {}

	/**
	 * The caller's grants, or with `scope: 'org'` every member's grant in the caller's organisation
	 * (needs `member:remove`). Most recently used first.
	 */
	list(principal: Principal, options: { scope?: 'mine' | 'org' } = {}): ConnectedApp[] {
		const org = options.scope === 'org';
		if (org) requirePermission(principal, CONNECTED_APPS_ORG_PERMISSION);
		const nowIso = new Date(this.ctx.now()).toISOString();
		let rows: GrantRow[];
		try {
			rows = this.ctx.sqlite
				.query<GrantRow, [string, string, string]>(
					`SELECT c.id, c.clientId, c.userId, c.scopes, c.createdAt, c.updatedAt,
					        cl.name, cl.uri, cl.icon,
					        u.name AS userName, u.email AS userEmail,
					        (SELECT m.role FROM member m WHERE m.userId = c.userId AND m.organizationId = ? LIMIT 1) AS memberRole,
					        usage.last_used_at AS lastUsedAt,
					        (SELECT max(r.createdAt) FROM oauthRefreshToken r WHERE r.userId = c.userId AND r.clientId = c.clientId) AS lastRefreshAt,
					        (SELECT count(*) FROM oauthRefreshToken r
					          WHERE r.userId = c.userId AND r.clientId = c.clientId AND r.revoked IS NULL AND r.expiresAt > ?) AS activeRefreshTokens
					   FROM oauthConsent c
					   LEFT JOIN oauthClient cl ON cl.clientId = c.clientId
					   LEFT JOIN user u ON u.id = c.userId
					   LEFT JOIN oauth_client_usage usage ON usage.user_id = c.userId AND usage.client_id = c.clientId
					  WHERE ${org ? 'c.userId IN (SELECT userId FROM member WHERE organizationId = ?)' : 'c.userId = ?'}`,
				)
				.all(principal.orgId, nowIso, org ? principal.orgId : principal.userId);
		} catch (error) {
			// Better Auth's tables are created on the control plane's first boot.
			if (isMissingTable(error)) return [];
			throw error;
		}
		return mergeGrants(rows)
			.map(toConnectedApp)
			.sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt));
	}

	/**
	 * Revoke a grant: its consent, refresh tokens and stored access tokens go, so the client's next
	 * call to `/mcp` is refused and it must ask for consent again. Revoking someone else's grant
	 * needs `member:remove` in their organisation; an owner's grant needs an owner.
	 */
	async revoke(
		principal: Principal,
		id: string,
	): Promise<{ revoked: true; clientId: string; userId: string; refreshTokens: number }> {
		const grant = this.findGrant(id);
		if (!grant) throw new NotFoundError('Connected app');
		const own = grant.userId === principal.userId;
		if (!own) {
			requirePermission(principal, CONNECTED_APPS_ORG_PERMISSION);
			const role = this.ctx.sqlite
				.query<{ role: string }, [string, string]>('SELECT role FROM member WHERE userId = ? AND organizationId = ? LIMIT 1')
				.get(grant.userId, principal.orgId)?.role;
			// Another organisation's grant is not this caller's to see, let alone revoke.
			if (!role) throw new NotFoundError('Connected app');
			if (role === 'owner' && !principal.permissions.has('iam:manage-owners'))
				throw new CoreError('forbidden', "Only an owner can revoke an owner's connected apps.", 403);
		}
		return this.ctx.audit.wrap(
			{
				principal,
				action: 'connected_app.revoke',
				resource: 'oauth_client',
				resourceId: grant.clientId,
				args: { client: grant.name ?? grant.clientId, user: grant.userId, own },
			},
			() => {
				const refreshTokens = this.ctx.sqlite.transaction(() => {
					const pair: [string, string] = [grant.userId, grant.clientId];
					this.ctx.sqlite.run('DELETE FROM oauthAccessToken WHERE userId = ? AND clientId = ?', pair);
					const refresh = this.ctx.sqlite.run('DELETE FROM oauthRefreshToken WHERE userId = ? AND clientId = ?', pair);
					this.ctx.sqlite.run('DELETE FROM oauthConsent WHERE userId = ? AND clientId = ?', pair);
					this.ctx.sqlite.run('DELETE FROM oauth_client_usage WHERE user_id = ? AND client_id = ?', pair);
					return refresh.changes;
				})();
				this.touched.delete(`${grant.userId}\u0000${grant.clientId}`);
				return { revoked: true as const, clientId: grant.clientId, userId: grant.userId, refreshTokens };
			},
		);
	}

	/**
	 * Whether an access token for (user, client) issued at `issuedAt` (JWT `iat`, seconds) is still
	 * backed by a grant. A grant made after the token (revoked, then approved again) does not
	 * revive it.
	 */
	grantActive(userId: string, clientId: string, issuedAt?: number): boolean {
		let rows: Array<{ createdAt: string | number | null }>;
		try {
			rows = this.ctx.sqlite
				.query<{ createdAt: string | number | null }, [string, string]>(
					'SELECT createdAt FROM oauthConsent WHERE userId = ? AND clientId = ?',
				)
				.all(userId, clientId);
		} catch (error) {
			if (isMissingTable(error)) return false;
			throw error;
		}
		if (issuedAt === undefined || !Number.isFinite(issuedAt)) return rows.length > 0;
		const issuedMs = issuedAt * 1000;
		return rows.some((row) => {
			const created = authDate(row.createdAt);
			// Consent times are stored to the second, like `iat`.
			return created !== null && created <= issuedMs;
		});
	}

	/** Record that the client just called for the user (throttled to once a minute per pair). */
	touch(userId: string, clientId: string): void {
		const key = `${userId}\u0000${clientId}`;
		const now = this.ctx.now();
		const last = this.touched.get(key);
		if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
		this.touched.set(key, now);
		if (this.touched.size > 10_000) this.touched.delete(this.touched.keys().next().value!);
		this.ctx.sqlite.run(
			`INSERT INTO oauth_client_usage (user_id, client_id, last_used_at) VALUES (?, ?, ?)
			 ON CONFLICT (user_id, client_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
			[userId, clientId, now],
		);
	}

	private findGrant(id: string): { userId: string; clientId: string; name: string | null } | undefined {
		try {
			return (
				this.ctx.sqlite
					.query<{ userId: string; clientId: string; name: string | null }, [string]>(
						`SELECT c.userId, c.clientId, cl.name FROM oauthConsent c
						   LEFT JOIN oauthClient cl ON cl.clientId = c.clientId WHERE c.id = ?`,
					)
					.get(id) ?? undefined
			);
		} catch (error) {
			if (isMissingTable(error)) return undefined;
			throw error;
		}
	}
}

/** A (user, client) pair can hold several consents (one per reference id): show it once. */
function mergeGrants(rows: GrantRow[]): GrantRow[] {
	const byPair = new Map<string, GrantRow>();
	for (const row of rows) {
		const key = `${row.userId}\u0000${row.clientId}`;
		const seen = byPair.get(key);
		if (!seen) {
			byPair.set(key, row);
			continue;
		}
		const scopes = [...new Set([...authList(seen.scopes), ...authList(row.scopes)])];
		const earliest = (authDate(row.createdAt) ?? Infinity) < (authDate(seen.createdAt) ?? Infinity) ? row : seen;
		byPair.set(key, { ...earliest, scopes: JSON.stringify(scopes), updatedAt: latest(seen.updatedAt, row.updatedAt) });
	}
	return [...byPair.values()];
}

function latest(a: string | number | null, b: string | number | null): string | number | null {
	return (authDate(a) ?? 0) >= (authDate(b) ?? 0) ? a : b;
}

function toConnectedApp(row: GrantRow): ConnectedApp {
	const createdAt = authDate(row.createdAt) ?? 0;
	const lastRefresh = authDate(row.lastRefreshAt);
	const lastUsed = Math.max(row.lastUsedAt ?? 0, lastRefresh ?? 0);
	return {
		id: row.id,
		clientId: row.clientId,
		name: row.name?.trim() || null,
		uri: row.uri || null,
		icon: row.icon || null,
		registration: /^https:\/\//i.test(row.clientId) ? 'metadata-document' : 'registered',
		scopes: authList(row.scopes),
		createdAt,
		updatedAt: authDate(row.updatedAt) ?? createdAt,
		lastUsedAt: lastUsed > 0 ? lastUsed : null,
		activeRefreshTokens: Number(row.activeRefreshTokens ?? 0),
		user: { id: row.userId, name: row.userName, email: row.userEmail, role: row.memberRole },
	};
}

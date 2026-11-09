/**
 * Access keys in a Yoal table (IAM.md I14, §4, §7.2, §12).
 *
 * A key belongs to one org and one principal: a user or a service account (`sa_…`). The raw
 * `yoal_…` key is returned exactly once, from `create`; only its hash is stored. The
 * `prefix` (`yoal_`) and `start` (the first eight visible characters) are kept so a key can be
 * recognised in the list without revealing it.
 *
 * Hash format decision (spike S1, answered): new Yoal keys are `yoal_` + 43 base64url characters
 * and are stored as `sha256(raw)` lowercase hex (`hash_scheme = 'sha256'`, 64 chars).
 *
 * Better Auth 1.7.15's `@better-auth/api-key` generates `yoal_` + 64 ASCII letters
 * (`defaultKeyLength = 64`, alphabet `a-z`/`A-Z`) and its `defaultKeyHasher` stores
 * `base64url(sha256(raw))` without padding (43 chars). Its `apikey.key` column is already that
 * hash. Because its format is distinguishable but not self-describing, migrated rows keep the
 * original hash verbatim and carry `hash_scheme = 'better-auth'`; `verify` checks the explicit
 * scheme column rather than guessing. A migrated key therefore verifies here without being
 * reissued, and its `apikey` row is left untouched as the fallback for rows not migrated yet.
 *
 * `restriction_json` is the credential's ceiling (`{ permissions, resources }`, IAM.md §2): it never
 * adds access, only narrows the principal's bindings. `allowed_cidrs` is enforced by the same
 * `ipInCidr` helper the authorization engine uses, and a key with CIDRs is refused when the request
 * carries no IP.
 */
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
	canMaintainPlatform,
	ipInCidr,
	isHumanPrincipal,
	isPermission,
	type Permission,
	type Principal,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { ForbiddenError, NotFoundError, ValidationError } from './errors.ts';
import { newId, parseJson, randomToken, sha256Hex } from './util.ts';

/** The visible prefix of every Yoal access key. */
export const ACCESS_KEY_PREFIX = 'yoal_';

/** How a `access_keys.hash` value was produced. New rows always use `sha256`. */
export type AccessKeyHashScheme = 'sha256' | 'better-auth';

/** Better Auth's `base64url(sha256(raw))` without padding, as `defaultKeyHasher` emits it. */
const BETTER_AUTH_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const MAX_NAME = 100;
/** At most one year; org policy may lower this when it lands (IAM.md §7.2). */
const MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
/** Service-account keys default to 90 days; user keys (CLI login) default to none (IAM.md §7.2). */
const SERVICE_ACCOUNT_DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;
/** `last_used_at` is written at most this often per key (IAM.md §7.2, §8.5). */
const TOUCH_INTERVAL_MS = 60_000;
const MAX_ALLOWED_CIDRS = 32;
const MAX_RESOURCES = 256;

export type AccessKeyPrincipalType = 'user' | 'serviceAccount';

export interface AccessKeyView {
	id: string;
	orgId: string;
	principalType: AccessKeyPrincipalType;
	principalId: string;
	name: string;
	prefix: string;
	start: string;
	/** The credential's permission ceiling, or null when it carries no permission restriction. */
	permissions: readonly Permission[] | null;
	/** The credential's resource ceiling (`type:id` / `type:*`), or null when unrestricted. */
	resources: readonly string[] | null;
	allowedCidrs: readonly string[];
	expiresAt: number | null;
	lastUsedAt: number | null;
	lastUsedIpHash: string | null;
	createdBy: string;
	revokedAt: number | null;
	createdAt: number;
}

export interface AccessKeyCreate {
	principalType?: AccessKeyPrincipalType;
	principalId?: string;
	name: string;
	permissions?: readonly string[];
	resources?: readonly string[];
	expiresInSeconds?: number;
	allowedCidrs?: readonly string[];
}

/** What a successful `verify` hands back; the raw key and hash never leave the service. */
export interface AccessKeyVerification {
	orgId: string;
	principalType: AccessKeyPrincipalType;
	principalId: string;
	permissions?: Permission[];
	resources?: string[];
	keyId: string;
}

/** Counts from one `migrateBetterAuthKeys` run. Safe to run repeatedly. */
export interface AccessKeyMigrationResult {
	/** `apikey` rows read. */
	examined: number;
	/** Rows inserted into `access_keys`. */
	migrated: number;
	/** Rows already present (idempotency is by hash), so nothing was written. */
	alreadyMigrated: number;
	/** Migrated rows that were disabled in Better Auth; they are inserted already revoked. */
	disabled: number;
	/** Rows skipped because the owner has no org membership, so no `org_id` can be chosen. */
	skippedNoOrg: number;
	/** Rows outside the requested org (only when an org filter was given). */
	skippedOtherOrg: number;
	/** Rows whose `apikey.key` is not a Better Auth base64url SHA-256 hash. */
	skippedInvalid: number;
}

/** The subset of Better Auth's `apikey` row the migration reads. */
interface BetterAuthApiKeyRow {
	id: string;
	referenceId: string;
	name: string | null;
	prefix: string | null;
	start: string | null;
	key: string;
	enabled: number | boolean | string | null;
	expiresAt: string | number | null;
	createdAt: string | number | null;
	lastRequest: string | number | null;
	metadata: string | null;
}

interface AccessKeyRow {
	id: string;
	org_id: string;
	principal_type: string;
	principal_id: string;
	name: string;
	prefix: string;
	start: string;
	hash: string;
	hash_scheme: AccessKeyHashScheme;
	restriction_json: string;
	allowed_cidrs: string;
	expires_at: number | null;
	last_used_at: number | null;
	last_used_ip_hash: string | null;
	created_by: string;
	revoked_at: number | null;
	created_at: number;
}

export class AccessKeyService {
	readonly #sqlite: Database;

	constructor(private readonly ctx: CoreContext) {
		this.#sqlite = ctx.sqlite;
	}

	// ---------------------------------------------------------------- reads

	/**
	 * Keys the caller may see. A principal sees its own keys; `accessKey:read-all` sees the org,
	 * optionally filtered to one principal id (`IAM.md` §3, §12).
	 */
	list(principal: Principal, options: { principalId?: string } = {}): AccessKeyView[] {
		const readAll = principal.permissions.has('accessKey:read-all');
		const manageKeys = principal.permissions.has('serviceAccount:manage-keys');
		const filterId = options.principalId?.trim();
		const forServiceAccount = Boolean(filterId?.startsWith('sa_'));

		// `serviceAccount:manage-keys` covers an account's keys in the caller's org, the same
		// permission that mints and revokes them. Anything else needs org-wide key read.
		if (!readAll && manageKeys && forServiceAccount) {
			this.#requireServiceAccount(principal.orgId, filterId!);
			return this.#sqlite
				.query<AccessKeyRow, [string, string]>(
					`SELECT * FROM access_keys
					 WHERE org_id = ? AND principal_type = 'serviceAccount' AND principal_id = ?
					 ORDER BY created_at DESC`,
				)
				.all(principal.orgId, filterId!)
				.map(view);
		}

		if (!readAll) this.#require(principal, 'accessKey:read');
		if (!readAll && filterId && filterId !== principal.userId)
			throw new ForbiddenError('accessKey:read-all');

		if (!readAll) {
			return this.#sqlite
				.query<AccessKeyRow, [string, string, string]>(
					`SELECT * FROM access_keys
					 WHERE org_id = ? AND principal_type = ? AND principal_id = ?
					 ORDER BY created_at DESC`,
				)
				.all(principal.orgId, callerType(principal), principal.userId)
				.map(view);
		}
		if (filterId) {
			return this.#sqlite
				.query<AccessKeyRow, [string, string]>(
					'SELECT * FROM access_keys WHERE org_id = ? AND principal_id = ? ORDER BY created_at DESC',
				)
				.all(principal.orgId, filterId)
				.map(view);
		}
		return this.#sqlite
			.query<AccessKeyRow, [string]>(
				'SELECT * FROM access_keys WHERE org_id = ? ORDER BY created_at DESC',
			)
			.all(principal.orgId)
			.map(view);
	}

	// ---------------------------------------------------------------- mutations

	/**
	 * Mint a key and return it exactly once. A user key needs `accessKey:create` and can only be
	 * minted for the caller; a service-account key needs `serviceAccount:manage-keys` and the
	 * account must belong to the caller's org.
	 */
	create(
		principal: Principal,
		input: AccessKeyCreate,
	): { accessKey: AccessKeyView; key: string } {
		const principalType = input.principalType ?? callerType(principal);
		if (principalType === 'user') this.#require(principal, 'accessKey:create');
		else this.#require(principal, 'serviceAccount:manage-keys');

		const principalId = input.principalId?.trim() || principal.userId;
		if (principalType === 'user') {
			if (principalId !== principal.userId)
				throw new ValidationError('A user access key can only be minted for yourself.');
		} else {
			this.#requireServiceAccount(principal.orgId, principalId);
		}

		const name = normalizeName(input.name);
		const permissions = normalizePermissions(input.permissions);
		const resources = normalizeResources(input.resources);
		const allowedCidrs = normalizeCidrs(input.allowedCidrs);
		const now = this.ctx.now();
		const expiresAt = expiryFor(input.expiresInSeconds, principalType, now);

		const key = `${ACCESS_KEY_PREFIX}${randomToken(32)}`;
		const id = newId('ak_');
		const restriction: { permissions?: Permission[]; resources?: string[] } = {
			...(permissions ? { permissions } : {}),
			...(resources ? { resources } : {}),
		};

		this.#sqlite.run(
			`INSERT INTO access_keys
			   (id, org_id, principal_type, principal_id, name, prefix, start, hash, hash_scheme,
			    restriction_json, allowed_cidrs, expires_at, last_used_at, last_used_ip_hash,
			    created_by, revoked_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sha256', ?, ?, ?, NULL, NULL, ?, NULL, ?)`,
			[
				id,
				principal.orgId,
				principalType,
				principalId,
				name,
				ACCESS_KEY_PREFIX,
				key.slice(0, 8),
				sha256Hex(key),
				JSON.stringify(restriction),
				JSON.stringify(allowedCidrs),
				expiresAt,
				principal.userId,
				now,
			],
		);

		this.ctx.audit.record({
			principal,
			action: 'access_key.create',
			resource: 'access_key',
			resourceId: id,
			args: {
				principalType,
				principalId,
				name,
				permissions: permissions ?? null,
				resources: resources ?? null,
				allowedCidrs,
				expiresAt,
			},
			result: 'ok',
		});

		return {
			accessKey: {
				id,
				orgId: principal.orgId,
				principalType,
				principalId,
				name,
				prefix: ACCESS_KEY_PREFIX,
				start: key.slice(0, 8),
				permissions: permissions ?? null,
				resources: resources ?? null,
				allowedCidrs,
				expiresAt,
				lastUsedAt: null,
				lastUsedIpHash: null,
				createdBy: principal.userId,
				revokedAt: null,
				createdAt: now,
			},
			key,
		};
	}

	/** Revoke one key. Own keys need `accessKey:revoke`; someone else's needs `accessKey:revoke-any`. */
	revoke(principal: Principal, id: string): AccessKeyView {
		const row = this.#sqlite
			.query<AccessKeyRow, [string, string]>(
				'SELECT * FROM access_keys WHERE id = ? AND org_id = ?',
			)
			.get(id, principal.orgId);
		if (!row) throw new NotFoundError('Access key');

		const own = row.principal_type === callerType(principal) && row.principal_id === principal.userId;
		if (own) {
			this.#require(principal, 'accessKey:revoke');
		} else if (
			row.principal_type === 'serviceAccount' &&
			principal.permissions.has('serviceAccount:manage-keys')
		) {
			// The same permission that mints an account's keys revokes them.
			this.#requireServiceAccount(principal.orgId, row.principal_id);
		} else {
			this.#require(principal, 'accessKey:revoke-any');
		}

		if (row.revoked_at !== null) return view(row);
		const now = this.ctx.now();
		this.#sqlite.run('UPDATE access_keys SET revoked_at = ? WHERE id = ?', [now, id]);
		this.ctx.audit.record({
			principal,
			action: 'access_key.revoke',
			resource: 'access_key',
			resourceId: id,
			args: {
				principalType: row.principal_type,
				principalId: row.principal_id,
				name: row.name,
				start: row.start,
			},
			result: 'ok',
		});
		return view({ ...row, revoked_at: now });
	}

	// ---------------------------------------------------------------- verification

	/**
	 * Verify a raw key. Returns `undefined` for an unknown, revoked or expired key, a mismatched
	 * CIDR, a disabled service account, or an allowed-CIDR key presented without an IP.
	 *
	 * Both hash schemes are checked by their explicit `hash_scheme`, so a migrated Better Auth key
	 * verifies with no change to the raw value. A successful use records `last_used_at` and a
	 * truncated IP hash, at most once a minute.
	 */
	verify(raw: string, options: { ip?: string; now?: number } = {}): AccessKeyVerification | undefined {
		if (!raw.startsWith(ACCESS_KEY_PREFIX)) return undefined;
		const row = this.#findByRaw(raw);
		if (!row || row.principal_type !== 'user' && row.principal_type !== 'serviceAccount')
			return undefined;

		const now = options.now ?? this.ctx.now();
		if (row.revoked_at !== null) return undefined;
		if (row.expires_at !== null && row.expires_at <= now) return undefined;

		const cidrs = parseStringArray(row.allowed_cidrs);
		if (cidrs.length > 0) {
			if (!options.ip || !cidrs.some((cidr) => ipInCidr(options.ip!, cidr))) return undefined;
		}

		// Disabling a service account is its normal off-switch; its keys stop working with it.
		if (row.principal_type === 'serviceAccount' && this.#serviceAccountDisabled(row.org_id, row.principal_id))
			return undefined;

		this.#touch(row, options.ip, now);
		const restriction = parseRestriction(row.restriction_json);
		return {
			orgId: row.org_id,
			principalType: row.principal_type,
			principalId: row.principal_id,
			permissions: restriction.permissions,
			resources: restriction.resources,
			keyId: row.id,
		};
	}

	/**
	 * Whether this raw key belongs to an `access_keys` row, even one `verify` would reject
	 * (revoked, expired, CIDR mismatch). The control plane uses this to decide whether the Better
	 * Auth fallback may run: once a key is migrated, `access_keys` is authoritative, so revoking or
	 * expiring it here cannot be undone by the untouched `apikey` row.
	 */
	recognizes(raw: string): boolean {
		return raw.startsWith(ACCESS_KEY_PREFIX) && this.#findByRaw(raw) !== undefined;
	}

	// ---------------------------------------------------------------- Better Auth migration

	/**
	 * Copy Better Auth `apikey` rows into `access_keys` without reissuing keys (spike S1, IAM.md
	 * §4/§14). The hash is preserved verbatim and marked `better-auth`, so `verify` accepts the same
	 * raw key. Rows are idempotent by hash; `apikey` is never modified or deleted, which keeps the
	 * control plane's Better Auth fallback working for anything this run skips.
	 *
	 * `orgId` filters the run (a platform admin may also omit it to migrate every org). A caller
	 * without platform maintenance is pinned to its own org. Only user-referenced keys are
	 * migrated: Better Auth's plugin here uses `references: 'user'` (auth.ts does not override it),
	 * and a key with no resolvable membership has nowhere to belong.
	 */
	migrateBetterAuthKeys(orgId?: string, principal?: Principal): AccessKeyMigrationResult {
		const maintainsPlatform = principal !== undefined && canMaintainPlatform(principal);
		if (principal && !maintainsPlatform && !principal.permissions.has('accessKey:read-all'))
			throw new ForbiddenError('accessKey:read-all');

		const scopedOrgId = principal && !maintainsPlatform ? principal.orgId : (orgId?.trim() || undefined);
		const result: AccessKeyMigrationResult = {
			examined: 0,
			migrated: 0,
			alreadyMigrated: 0,
			disabled: 0,
			skippedNoOrg: 0,
			skippedOtherOrg: 0,
			skippedInvalid: 0,
		};
		const now = this.ctx.now();
		const orgByUser = new Map<string, string | null>();

		this.#sqlite.transaction(() => {
			for (const apiKey of this.#betterAuthKeyRows()) {
				result.examined++;

				if (!BETTER_AUTH_HASH_PATTERN.test(apiKey.key)) {
					result.skippedInvalid++;
					continue;
				}
				const existing = this.#sqlite
					.query<{ id: string }, [string]>('SELECT id FROM access_keys WHERE hash = ?')
					.get(apiKey.key);
				if (existing) {
					result.alreadyMigrated++;
					continue;
				}

				let userOrg = orgByUser.get(apiKey.referenceId);
				if (userOrg === undefined) {
					userOrg = preferredOrgForUser(this.#sqlite, apiKey.referenceId) ?? null;
					orgByUser.set(apiKey.referenceId, userOrg);
				}
				if (!userOrg) {
					result.skippedNoOrg++;
					continue;
				}
				if (scopedOrgId && userOrg !== scopedOrgId) {
					result.skippedOtherOrg++;
					continue;
				}

				const permissions = betterAuthScopes(apiKey.metadata);
				const restriction = JSON.stringify(permissions ? { permissions } : {});
				const start = (apiKey.start ?? apiKey.prefix ?? ACCESS_KEY_PREFIX).slice(0, 8);
				const disabled =
					apiKey.enabled === 0 || apiKey.enabled === false || apiKey.enabled === '0' || apiKey.enabled === 'false';
				this.#sqlite.run(
					`INSERT INTO access_keys
					   (id, org_id, principal_type, principal_id, name, prefix, start, hash, hash_scheme,
					    restriction_json, allowed_cidrs, expires_at, last_used_at, last_used_ip_hash,
					    created_by, revoked_at, created_at)
					 VALUES (?, ?, 'user', ?, ?, ?, ?, ?, 'better-auth', ?, '[]', ?, ?, NULL, ?, ?, ?)`,
					[
						newId('ak_'),
						userOrg,
						apiKey.referenceId,
						migratedName(apiKey.name, start),
						apiKey.prefix?.trim() || ACCESS_KEY_PREFIX,
						start,
						apiKey.key,
						restriction,
						epochFrom(apiKey.expiresAt),
						epochFrom(apiKey.lastRequest),
						apiKey.referenceId,
						disabled ? now : null,
						epochFrom(apiKey.createdAt) ?? now,
					],
				);
				result.migrated++;
				if (disabled) result.disabled++;
			}
		})();

		if (principal) {
			this.ctx.audit.record({
				principal,
				action: 'access_key.migrate',
				resource: 'access_key',
				resourceId: scopedOrgId ?? 'all',
				args: { orgId: scopedOrgId ?? null, ...result },
				result: 'ok',
			});
		}
		return result;
	}

	// ---------------------------------------------------------------- internals

	#findByRaw(raw: string): AccessKeyRow | undefined {
		return (
			this.#findByHash(sha256Hex(raw), 'sha256') ??
			this.#findByHash(betterAuthKeyHash(raw), 'better-auth')
		);
	}

	#findByHash(hash: string, scheme: AccessKeyHashScheme): AccessKeyRow | undefined {
		return this.#sqlite
			.query<AccessKeyRow, [string, string]>(
				'SELECT * FROM access_keys WHERE hash = ? AND hash_scheme = ?',
			)
			.get(hash, scheme) ?? undefined;
	}

	#betterAuthKeyRows(): BetterAuthApiKeyRow[] {
		try {
			return this.#sqlite
				.query<BetterAuthApiKeyRow, []>(
					`SELECT id, referenceId, name, prefix, start, key, enabled, expiresAt, createdAt,
					        lastRequest, metadata
					   FROM apikey`,
				)
				.all();
		} catch {
			// Better Auth's table is created at boot; a unit-test database may not have it.
			return [];
		}
	}

	#touch(row: AccessKeyRow, ip: string | undefined, now: number): void {
		const ipHash = ip ? hashUsageIp(ip) : row.last_used_ip_hash;
		try {
			this.#sqlite.run(
				`UPDATE access_keys SET last_used_at = ?, last_used_ip_hash = ?
				 WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)`,
				[now, ipHash, row.id, now - TOUCH_INTERVAL_MS],
			);
		} catch {
			// Last-used bookkeeping is not worth failing an authenticated request over.
		}
	}

	#requireServiceAccount(orgId: string, id: string): void {
		const row = this.#sqlite
			.query<{ id: string }, [string, string]>(
				'SELECT id FROM service_accounts WHERE id = ? AND org_id = ?',
			)
			.get(id, orgId);
		if (!row) throw new NotFoundError('Service account');
	}

	#serviceAccountDisabled(orgId: string, id: string): boolean {
		try {
			const row = this.#sqlite
				.query<{ disabled_at: number | null }, [string, string]>(
					'SELECT disabled_at FROM service_accounts WHERE id = ? AND org_id = ?',
				)
				.get(id, orgId);
			// A deleted account is treated like a disabled one: its keys can no longer authenticate.
			return !row || row.disabled_at !== null;
		} catch {
			// Fail closed if the table is unavailable, rather than letting a machine key through.
			return true;
		}
	}

	#require(principal: Principal, permission: Permission): void {
		if (!principal.permissions.has(permission)) throw new ForbiddenError(permission);
	}
}

function callerType(principal: Principal): AccessKeyPrincipalType {
	// `user` covers every human surface (session, key, MCP); the rest are machines.
	return isHumanPrincipal(principal) ? 'user' : 'serviceAccount';
}

function view(row: AccessKeyRow): AccessKeyView {
	const restriction = parseRestriction(row.restriction_json);
	return {
		id: row.id,
		orgId: row.org_id,
		principalType: row.principal_type as AccessKeyPrincipalType,
		principalId: row.principal_id,
		name: row.name,
		prefix: row.prefix,
		start: row.start,
		permissions: restriction.permissions ?? null,
		resources: restriction.resources ?? null,
		allowedCidrs: parseStringArray(row.allowed_cidrs),
		expiresAt: row.expires_at,
		lastUsedAt: row.last_used_at,
		lastUsedIpHash: row.last_used_ip_hash,
		createdBy: row.created_by,
		revokedAt: row.revoked_at,
		createdAt: row.created_at,
	};
}

function normalizeName(raw: string): string {
	const name = raw.trim();
	if (name.length < 1 || name.length > MAX_NAME)
		throw new ValidationError(`A key name must be 1–${MAX_NAME} characters.`);
	if (/[\u0000-\u001f\u007f]/.test(name))
		throw new ValidationError('A key name cannot contain control characters.');
	return name;
}

function normalizePermissions(raw: readonly string[] | undefined): Permission[] | undefined {
	if (raw === undefined) return undefined;
	const out: Permission[] = [];
	for (const value of raw) {
		const permission = value.trim();
		if (!isPermission(permission) || permission.includes('*'))
			throw new ValidationError(`"${value}" is not a permission in the catalog.`);
		if (!out.includes(permission)) out.push(permission);
	}
	return out.length > 0 ? out : undefined;
}

function normalizeResources(raw: readonly string[] | undefined): string[] | undefined {
	if (raw === undefined) return undefined;
	const out: string[] = [];
	for (const value of raw) {
		const resource = value.trim();
		if (!/^[a-zA-Z][a-zA-Z0-9]*:(\*|[^\s:*]+)$/.test(resource))
			throw new ValidationError(`"${value}" is not a resource limit (expected type:id or type:*).`);
		if (resource.length > 200) throw new ValidationError('A resource limit is at most 200 characters.');
		if (!out.includes(resource)) out.push(resource);
		if (out.length > MAX_RESOURCES)
			throw new ValidationError(`A key carries at most ${MAX_RESOURCES} resource limits.`);
	}
	return out.length > 0 ? out : undefined;
}

function normalizeCidrs(raw: readonly string[] | undefined): string[] {
	if (raw === undefined) return [];
	const out: string[] = [];
	for (const value of raw) {
		const cidr = value.trim();
		if (!isIpv4Cidr(cidr))
			throw new ValidationError(`"${value}" is not an IPv4 address or CIDR (for example 10.0.0.0/8).`);
		if (!out.includes(cidr)) out.push(cidr);
		if (out.length > MAX_ALLOWED_CIDRS)
			throw new ValidationError(`A key allows at most ${MAX_ALLOWED_CIDRS} CIDRs.`);
	}
	return out;
}

function expiryFor(
	expiresInSeconds: number | undefined,
	principalType: AccessKeyPrincipalType,
	now: number,
): number | null {
	if (expiresInSeconds === undefined)
		return principalType === 'serviceAccount'
			? now + SERVICE_ACCOUNT_DEFAULT_TTL_SECONDS * 1000
			: null;
	if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0)
		throw new ValidationError('expiresInSeconds must be a positive whole number of seconds.');
	if (expiresInSeconds > MAX_TTL_SECONDS)
		throw new ValidationError(`A key expires in at most ${MAX_TTL_SECONDS} seconds (one year).`);
	return now + expiresInSeconds * 1000;
}

function parseRestriction(json: string): { permissions?: Permission[]; resources?: string[] } {
	const parsed = parseJson<unknown>(json, {});
	const value =
		parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	const permissions = Array.isArray(value.permissions)
		? value.permissions.filter(
				(entry): entry is Permission => typeof entry === 'string' && isPermission(entry),
			)
		: undefined;
	const resources = Array.isArray(value.resources)
		? value.resources.filter((entry): entry is string => typeof entry === 'string')
		: undefined;
	return {
		permissions: permissions && permissions.length > 0 ? permissions : undefined,
		resources: resources && resources.length > 0 ? resources : undefined,
	};
}

function parseStringArray(json: string): string[] {
	const value = parseJson<unknown>(json, []);
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Better Auth `@better-auth/api-key` 1.7.15 `defaultKeyHasher`: SHA-256 of the UTF-8 raw key,
 * base64url-encoded without padding. This is the value stored in `apikey.key`; migrated rows keep
 * it verbatim under `hash_scheme = 'better-auth'`.
 */
function betterAuthKeyHash(raw: string): string {
	return createHash('sha256').update(raw).digest('base64url');
}

/** `metadata.scopes` from a Better Auth row, filtered to permissions this catalog knows. */
function betterAuthScopes(metadata: string | null): Permission[] | undefined {
	const value = parseJson<unknown>(metadata, null);
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const scopes = (value as Record<string, unknown>).scopes;
	if (!Array.isArray(scopes)) return undefined;
	const out: Permission[] = [];
	for (const scope of scopes) {
		if (typeof scope !== 'string') continue;
		const permission = scope.trim();
		if (!isPermission(permission) || out.includes(permission)) continue;
		out.push(permission);
	}
	return out.length > 0 ? out : undefined;
}

/**
 * The org a migrated user key belongs to: the org the user last worked in, else their first
 * membership (the same rule `principalFromSession` uses, IAM.md I5, §8.1). The `user` table is
 * Better Auth's and may be absent in a unit-test database, so failures fall through.
 */
function preferredOrgForUser(sqlite: Database, userId: string): string | undefined {
	try {
		const preferred = sqlite
			.query<{ orgId: string }, [string]>(
				`SELECT m.organizationId AS orgId
				   FROM user u
				   JOIN member m ON m.userId = u.id AND m.organizationId = u.lastOrganizationId
				  WHERE u.id = ?
				  LIMIT 1`,
			)
			.get(userId);
		if (preferred) return preferred.orgId;
	} catch {
		// No `user` table (unit tests / bootstrapping) or no lastOrganizationId column yet.
	}
	try {
		return sqlite
			.query<{ orgId: string }, [string]>(
				'SELECT organizationId AS orgId FROM member WHERE userId = ? ORDER BY createdAt ASC LIMIT 1',
			)
			.get(userId)?.orgId;
	} catch {
		return undefined;
	}
}

/** Better Auth stores dates as ISO-8601 text through its SQLite adapter; accept epoch too. */
function epochFrom(value: string | number | null): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value !== 'string' || !value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** A migrated row needs a display name; `apikey.name` is optional and capped at 32 by the plugin. */
function migratedName(name: string | null, start: string): string {
	const cleaned = (name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
	return (cleaned || `Migrated key ${start}`).slice(0, MAX_NAME);
}

/** Validation only; `ipInCidr` does the matching. IPv6 fails closed until the engine supports it. */
function isIpv4Cidr(value: string): boolean {
	const [address, bits, ...rest] = value.split('/');
	if (rest.length > 0 || !address) return false;
	const octets = address.split('.');
	if (octets.length !== 4) return false;
	for (const octet of octets) {
		if (!/^\d{1,3}$/.test(octet) || Number(octet) > 255) return false;
	}
	if (bits === undefined) return true;
	if (!/^\d{1,2}$/.test(bits)) return false;
	const prefix = Number(bits);
	return prefix >= 0 && prefix <= 32;
}

/** Same shape as the control plane's `hashIp`: a truncated hash, never the raw address. */
function hashUsageIp(ip: string): string {
	return sha256Hex(`ip:${ip}`).slice(0, 16);
}

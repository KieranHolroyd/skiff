/**
 * Access keys in a Skiff table (IAM.md I14, §4, §7.2, §12).
 *
 * A key belongs to one org and one principal: a user or a service account (`sa_…`). The raw
 * `skif_…` key is returned exactly once, from `create`; only its SHA-256 hex hash is stored. The
 * `prefix` (`skif_`) and `start` (the first eight visible characters) are kept so a key can be
 * recognised in the list without revealing it.
 *
 * Hash format decision: this table uses `sha256(raw)` hex. It deliberately does not try to match
 * Better Auth's `apikey` hash format. Migrating those rows (spike S1) is still open, so the control
 * plane keeps verifying Better Auth keys first and only falls through to `verify` here.
 *
 * `restriction_json` is the credential's ceiling (`{ permissions, resources }`, IAM.md §2): it never
 * adds access, only narrows the principal's bindings. `allowed_cidrs` is enforced by the same
 * `ipInCidr` helper the authorization engine uses, and a key with CIDRs is refused when the request
 * carries no IP.
 */
import type { Database } from 'bun:sqlite';
import { ipInCidr, isHumanPrincipal, isPermission, type Permission, type Principal } from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ForbiddenError, NotFoundError, ValidationError } from './errors.ts';
import { newId, parseJson, randomToken, sha256Hex } from './util.ts';

/** The visible prefix of every Skiff access key. */
export const ACCESS_KEY_PREFIX = 'skif_';

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

interface AccessKeyRow {
	id: string;
	org_id: string;
	principal_type: string;
	principal_id: string;
	name: string;
	prefix: string;
	start: string;
	hash: string;
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
			   (id, org_id, principal_type, principal_id, name, prefix, start, hash, restriction_json,
			    allowed_cidrs, expires_at, last_used_at, last_used_ip_hash, created_by, revoked_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?)`,
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
	 * A successful use records `last_used_at` and a truncated IP hash, at most once a minute.
	 */
	verify(raw: string, options: { ip?: string; now?: number } = {}): AccessKeyVerification | undefined {
		if (!raw.startsWith(ACCESS_KEY_PREFIX)) return undefined;
		const row = this.#sqlite
			.query<AccessKeyRow, [string]>('SELECT * FROM access_keys WHERE hash = ?')
			.get(sha256Hex(raw));
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

	// ---------------------------------------------------------------- internals

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

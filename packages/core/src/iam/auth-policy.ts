/**
 * Org authentication policy (IAM.md I21, §4, §8.5).
 *
 * One row per organisation decides four things that sit above the four-role RBAC:
 *
 * - whether members must sign in through the org's identity provider (`require_sso`), with an
 *   explicit break-glass list of owners who keep password/passkey/TOTP;
 * - whether everyone in the org must prove a second factor (`require_2fa`). The owner gate in
 *   `second-factor-policy.ts` stays as a floor: turning this off never weakens it;
 * - which sign-in methods are offered (`allowed_methods`);
 * - session limits (`session_max_age`, `idle_timeout`) and an `ip_allowlist`.
 *
 * The service is deliberately small: the enforcement lives in the control plane's request hook
 * (sessions) and Better Auth hooks (sign-in method), so this module only validates and stores the
 * policy. Reads are permission-checked; `forOrg` is the internal, unauthenticated read that the
 * hook needs before a principal exists.
 */
import type { Principal } from '@skiff/contracts';
import type { CoreContext } from '../context.ts';
import { ValidationError } from '../errors.ts';

/** The sign-in methods a policy can allow (IAM.md §8.5). */
export const AUTH_METHODS = ['password', 'passkey', 'github', 'magic-link', 'sso'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const DEFAULT_ALLOWED_METHODS: readonly AuthMethod[] = [...AUTH_METHODS];

/** A session may live at most a year; an idle timeout at most 30 days. */
export const MAX_SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
export const MAX_IDLE_TIMEOUT_SECONDS = 30 * 24 * 60 * 60;
export const MIN_SESSION_LIMIT_SECONDS = 5 * 60;

const MAX_ALLOWED_CIDRS = 64;
const MAX_BREAK_GLASS_USERS = 32;

export interface OrgAuthPolicy {
	orgId: string;
	requireSso: boolean;
	require2fa: boolean;
	allowedMethods: AuthMethod[];
	/** Seconds; `null` means no maximum age. */
	sessionMaxAge: number | null;
	/** Seconds; `null` means no idle timeout. */
	idleTimeout: number | null;
	ipAllowlist: string[];
	breakGlassUserIds: string[];
}

export type OrgAuthPolicyInput = Partial<
	Omit<OrgAuthPolicy, 'orgId'>
>;

interface AuthPolicyRow {
	org_id: string;
	require_sso: number;
	require_2fa: number;
	allowed_methods_json: string;
	session_max_age: number | null;
	idle_timeout: number | null;
	ip_allowlist_json: string;
	break_glass_user_ids_json: string;
}

/** The defaults: no restrictions, every method. Missing rows read as this. */
export function defaultAuthPolicy(orgId: string): OrgAuthPolicy {
	return {
		orgId,
		requireSso: false,
		require2fa: false,
		allowedMethods: [...DEFAULT_ALLOWED_METHODS],
		sessionMaxAge: null,
		idleTimeout: null,
		ipAllowlist: [],
		breakGlassUserIds: [],
	};
}

function isAuthMethod(value: unknown): value is AuthMethod {
	return typeof value === 'string' && (AUTH_METHODS as readonly string[]).includes(value);
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function parseMethods(raw: string): AuthMethod[] {
	try {
		const parsed = JSON.parse(raw) as unknown;
		const methods = stringArray(parsed).filter(isAuthMethod);
		return methods.length > 0 ? [...new Set(methods)] : [...DEFAULT_ALLOWED_METHODS];
	} catch {
		return [...DEFAULT_ALLOWED_METHODS];
	}
}

function parseStringList(raw: string): string[] {
	try {
		return stringArray(JSON.parse(raw) as unknown);
	} catch {
		return [];
	}
}

/** `true`, `1`, `10.0.0.0/8` and a bare IPv4 address, matching the access-key allowlists. */
export function isIpv4Cidr(value: string): boolean {
	const [address, prefix, ...rest] = value.trim().split('/');
	if (rest.length > 0 || !address) return false;
	const octets = address.split('.');
	if (octets.length !== 4) return false;
	for (const octet of octets) {
		if (!/^\d{1,3}$/.test(octet)) return false;
		const number = Number(octet);
		if (number < 0 || number > 255) return false;
	}
	if (prefix === undefined) return true;
	if (!/^\d{1,2}$/.test(prefix)) return false;
	const bits = Number(prefix);
	return bits >= 0 && bits <= 32;
}

function cleanCidrs(raw: readonly string[] | undefined): string[] {
	if (raw === undefined) return [];
	const out: string[] = [];
	for (const value of raw) {
		const cidr = value.trim();
		if (!cidr) continue;
		if (!isIpv4Cidr(cidr))
			throw new ValidationError(
				`"${value}" is not an IPv4 address or CIDR (for example 10.0.0.0/8).`
			);
		if (!out.includes(cidr)) out.push(cidr);
		if (out.length > MAX_ALLOWED_CIDRS)
			throw new ValidationError(`An auth policy allows at most ${MAX_ALLOWED_CIDRS} CIDRs.`);
	}
	return out;
}

function cleanMethods(raw: readonly string[] | undefined): AuthMethod[] {
	if (raw === undefined) return [...DEFAULT_ALLOWED_METHODS];
	const out: AuthMethod[] = [];
	for (const value of raw) {
		if (!isAuthMethod(value))
			throw new ValidationError(
				`"${value}" is not a sign-in method. Use ${AUTH_METHODS.join(', ')}.`
			);
		if (!out.includes(value)) out.push(value);
	}
	if (out.length === 0)
		throw new ValidationError('Keep at least one sign-in method, or members cannot sign in.');
	return out;
}

function cleanLimit(
	value: number | null | undefined,
	label: string,
	max: number,
	base: number | null
): number | null {
	if (value === undefined) return base;
	if (value === null || value === 0) return null;
	if (!Number.isInteger(value) || value < MIN_SESSION_LIMIT_SECONDS)
		throw new ValidationError(
			`${label} must be at least ${MIN_SESSION_LIMIT_SECONDS / 60} minutes in whole seconds.`
		);
	if (value > max)
		throw new ValidationError(`${label} is too long (maximum ${max / 86_400} days).`);
	return value;
}

/**
 * Validate and normalise an update against the current policy. Pure enough to unit-test: it throws
 * `ValidationError` for bad input and never touches the database.
 */
export function normalizeAuthPolicy(
	orgId: string,
	input: OrgAuthPolicyInput,
	base: OrgAuthPolicy = defaultAuthPolicy(orgId)
): OrgAuthPolicy {
	const requireSso = input.requireSso ?? base.requireSso;
	const require2fa = input.require2fa ?? base.require2fa;
	const allowedMethods = cleanMethods(input.allowedMethods ?? base.allowedMethods);
	const sessionMaxAge = cleanLimit(
		input.sessionMaxAge,
		'Session maximum age',
		MAX_SESSION_MAX_AGE_SECONDS,
		base.sessionMaxAge
	);
	const idleTimeout = cleanLimit(
		input.idleTimeout,
		'Idle timeout',
		MAX_IDLE_TIMEOUT_SECONDS,
		base.idleTimeout
	);
	if (sessionMaxAge !== null && idleTimeout !== null && idleTimeout > sessionMaxAge)
		throw new ValidationError('The idle timeout cannot be longer than the session maximum age.');

	const ipAllowlist = cleanCidrs(input.ipAllowlist ?? base.ipAllowlist);
	const breakGlassUserIds: string[] = [];
	for (const raw of input.breakGlassUserIds ?? base.breakGlassUserIds) {
		const id = raw.trim();
		if (!id) continue;
		if (!breakGlassUserIds.includes(id)) breakGlassUserIds.push(id);
		if (breakGlassUserIds.length > MAX_BREAK_GLASS_USERS)
			throw new ValidationError(
				`List at most ${MAX_BREAK_GLASS_USERS} break-glass owners.`
			);
	}
	if (requireSso && breakGlassUserIds.length === 0)
		throw new ValidationError(
			'Turning on required SSO needs at least one break-glass owner, or an IdP outage locks everyone out.'
		);

	return {
		orgId,
		requireSso,
		require2fa,
		allowedMethods,
		sessionMaxAge,
		idleTimeout,
		ipAllowlist,
		breakGlassUserIds,
	};
}

function rowToPolicy(row: AuthPolicyRow): OrgAuthPolicy {
	return {
		orgId: row.org_id,
		requireSso: row.require_sso === 1,
		require2fa: row.require_2fa === 1,
		allowedMethods: parseMethods(row.allowed_methods_json),
		sessionMaxAge: row.session_max_age ?? null,
		idleTimeout: row.idle_timeout ?? null,
		ipAllowlist: parseStringList(row.ip_allowlist_json),
		breakGlassUserIds: parseStringList(row.break_glass_user_ids_json),
	};
}

/** The org's policy, without a permission check. For hooks that run before a principal exists. */
export class AuthPolicyService {
	constructor(private readonly ctx: CoreContext) {}

	/**
	 * Internal read. A missing table (an install that has not run migration 0089 yet) is the
	 * defaults, never an exception: every request reads this path.
	 */
	forOrg(orgId: string): OrgAuthPolicy {
		try {
			const row = this.ctx.sqlite
				.query<AuthPolicyRow, [string]>('SELECT * FROM org_auth_policies WHERE org_id = ?')
				.get(orgId);
			return row ? rowToPolicy(row) : defaultAuthPolicy(orgId);
		} catch {
			return defaultAuthPolicy(orgId);
		}
	}

	get(principal: Principal): OrgAuthPolicy {
		this.ctx.iam.require(principal, 'sso:read', { type: 'org' });
		return this.forOrg(principal.orgId);
	}

	update(principal: Principal, input: OrgAuthPolicyInput): OrgAuthPolicy {
		this.ctx.iam.require(principal, 'sso:manage', { type: 'org' });
		const before = this.forOrg(principal.orgId);
		const policy = normalizeAuthPolicy(principal.orgId, input, before);
		this.#assertBreakGlassOwners(principal.orgId, policy.breakGlassUserIds);

		try {
			this.ctx.sqlite.run(
				`INSERT INTO org_auth_policies
				   (org_id, require_sso, require_2fa, allowed_methods_json, session_max_age,
				    idle_timeout, ip_allowlist_json, break_glass_user_ids_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(org_id) DO UPDATE SET
				   require_sso = excluded.require_sso,
				   require_2fa = excluded.require_2fa,
				   allowed_methods_json = excluded.allowed_methods_json,
				   session_max_age = excluded.session_max_age,
				   idle_timeout = excluded.idle_timeout,
				   ip_allowlist_json = excluded.ip_allowlist_json,
				   break_glass_user_ids_json = excluded.break_glass_user_ids_json`,
				[
					policy.orgId,
					policy.requireSso ? 1 : 0,
					policy.require2fa ? 1 : 0,
					JSON.stringify(policy.allowedMethods),
					policy.sessionMaxAge,
					policy.idleTimeout,
					JSON.stringify(policy.ipAllowlist),
					JSON.stringify(policy.breakGlassUserIds),
				]
			);
		} catch (cause) {
			if (String(cause).includes('no such table'))
				throw new ValidationError(
					'The org auth-policy table is missing. Run the database migrations, then save again.'
				);
			throw cause;
		}

		this.ctx.audit.record({
			principal,
			action: 'sso.auth_policy.update',
			resource: 'sso_auth_policy',
			resourceId: principal.orgId,
			args: {
				before,
				after: policy,
			},
			result: 'ok',
		});
		return policy;
	}

	/** Every break-glass id must still be an owner of this organisation. */
	#assertBreakGlassOwners(orgId: string, userIds: readonly string[]): void {
		if (userIds.length === 0) return;
		for (const userId of userIds) {
			const row = this.ctx.sqlite
				.query<{ role: string }, [string, string]>(
					'SELECT role FROM member WHERE organizationId = ? AND userId = ?'
				)
				.get(orgId, userId);
			if (!row || row.role !== 'owner')
				throw new ValidationError(
					'Every break-glass user must be an owner of this organisation.'
				);
		}
	}
}

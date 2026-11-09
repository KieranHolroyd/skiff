/**
 * Pure helpers for SSO domain ownership and email routing (IAM.md I19, §8.3).
 *
 * Domains are the bridge between an email address and an identity provider: `/login` asks for the
 * email first, then sends the browser to the IdP of the organisation that has verified the domain.
 * Two rules matter for safety:
 *
 * - Matching is exact on the registrable hostname. `mail.example.com` does not route to an IdP that
 *   verified `example.com` unless that exact host is listed; suffix matching would let anyone who
 *   controls a delegated subdomain claim the parent.
 * - Only a verified row routes. A pending token, or one whose record has disappeared, must never
 *   send a user to an IdP (or let an unverified domain claim an organisation).
 *
 * The TXT value is `skiff-verify=<token>` published on the domain itself, mirroring the email
 * domain check (D116). This module is deliberately free of I/O so the API, the dashboard and tests
 * all agree; the DNS lookup and token generation live in the control plane.
 */

/** The DNS TXT value an organisation publishes to prove it owns a domain. */
export const SSO_VERIFY_PREFIX = 'skiff-verify=';

/** How long a verification result is trusted before the record is checked again (IAM.md §8.3). */
export const SSO_RECHECK_MS = 24 * 60 * 60 * 1000;

/** A hostname with at least two labels; no wildcard, underscore, scheme or port. */
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/;

/**
 * Normalise what someone typed into a domain field: lowercase, no scheme, path, port or trailing
 * dot. Returns `null` for anything that is not a bare public hostname, so a URL or an email address
 * in the domain box is a validation error rather than a silently wrong record.
 */
export function normalizeSsoDomain(input: string): string | null {
	let value = input.trim().toLowerCase();
	if (!value) return null;
	if (value.endsWith('.')) value = value.slice(0, -1);
	if (value.includes('://') || value.includes('/') || value.includes('@') || value.includes(':'))
		return null;
	if (value.length > 253) return null;
	// A bare IPv4 address is not a registrable domain.
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
	return HOSTNAME.test(value) ? value : null;
}

/** The lowercased domain of an email address, or `null` when it is not one address. */
export function emailDomain(email: string): string | null {
	const value = email.trim().toLowerCase();
	const at = value.lastIndexOf('@');
	if (at <= 0 || at === value.length - 1) return null;
	const local = value.slice(0, at);
	if (!local || local.includes('@')) return null;
	return normalizeSsoDomain(value.slice(at + 1));
}

/**
 * The verified domain an email belongs to, from rows shaped like `sso_domains`. Matching is exact:
 * an address is routed only by the domain it actually uses.
 */
export function verifiedDomainForEmail<T extends { domain: string; verifiedAt: number | null }>(
	email: string,
	domains: Iterable<T>
): T | null {
	const domain = emailDomain(email);
	if (!domain) return null;
	for (const row of domains) {
		if (row.verifiedAt === null) continue;
		if (normalizeSsoDomain(row.domain) === domain) return row;
	}
	return null;
}

/** The exact TXT value to publish at the domain. */
export function ssoVerificationRecord(token: string): string {
	return `${SSO_VERIFY_PREFIX}${token.trim()}`;
}

/**
 * Whether any TXT record at the domain carries this verification token. Each record arrives as its
 * character-strings; they are joined first because a resolver (or Bun) may split one value.
 */
export function hasSsoVerificationRecord(
	records: readonly (readonly string[])[],
	token: string
): boolean {
	const expected = ssoVerificationRecord(token);
	for (const record of records) {
		if (record.join('').trim() === expected) return true;
	}
	return false;
}

/** A row is due when it has never been checked, or its last check is a day old. */
export function ssoDomainCheckDue(
	lastCheckedAt: number | null,
	now: number,
	interval = SSO_RECHECK_MS
): boolean {
	return lastCheckedAt === null || now - lastCheckedAt >= interval;
}

// ---------------------------------------------------------------- IdP group mapping (I19, §8.3)

/** A claim value longer than this is not a group name; ignore it rather than store it. */
export const MAX_GROUP_CLAIM_LENGTH = 200;

/**
 * Normalise one IdP group claim for storage and comparison. Directory services disagree about
 * whitespace and case (`Engineering`, ` engineering `), and a mapping that silently stops matching
 * after an IdP rename defeats the point of syncing groups. Matching is therefore case-insensitive;
 * the display value from the IdP is not used anywhere, only the Skiff group id is.
 */
export function normalizeGroupClaim(value: string): string | null {
	const claim = value.trim().toLowerCase();
	if (!claim || claim.length > MAX_GROUP_CLAIM_LENGTH) return null;
	return claim;
}

/**
 * Read the groups claim from an IdP's userinfo/ID token into normalised, de-duplicated values.
 *
 * Accepts an array (Okta, Entra, most OIDC providers), a comma- or newline-separated string
 * (Auth0 and custom mappers), and a JSON array encoded as a string (some SAML/OIDC bridges).
 * `undefined`/`null` stays `undefined` rather than becoming an empty list: a missing claim must
 * not be treated as "the user is in no groups", or a misconfigured claim name would wipe access.
 */
export function groupClaimValues(raw: unknown): string[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	let values: unknown[];
	if (Array.isArray(raw)) values = raw;
	else if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) return [];
		if (trimmed.startsWith('[')) {
			try {
				const parsed: unknown = JSON.parse(trimmed);
				values = Array.isArray(parsed) ? parsed : [parsed];
			} catch {
				values = trimmed.split(',');
			}
		} else values = trimmed.split(/[,\n]/);
	} else values = [raw];

	const out: string[] = [];
	for (const value of values) {
		if (typeof value !== 'string') continue;
		const claim = normalizeGroupClaim(value);
		if (claim && !out.includes(claim)) out.push(claim);
	}
	return out;
}

/** The group a mapping row points at, as stored in `sso_group_mappings`. */
export interface GroupClaimMapping {
	claimValue: string;
	groupId: string;
}

/**
 * Resolve the IdP claims a user presented against the organisation's mappings. Returns unique
 * Skiff group ids; unknown claims are ignored, so adding a new IdP group never grants access
 * until an administrator maps it. Local groups are not involved here — only membership rows.
 */
export function groupIdsForClaims(
	claims: readonly string[] | undefined,
	mappings: readonly GroupClaimMapping[]
): string[] {
	if (!claims || claims.length === 0) return [];
	const wanted = new Set(
		claims.map(normalizeGroupClaim).filter((claim): claim is string => claim !== null)
	);
	const out: string[] = [];
	for (const mapping of mappings) {
		const claim = normalizeGroupClaim(mapping.claimValue);
		if (claim && wanted.has(claim) && !out.includes(mapping.groupId)) out.push(mapping.groupId);
	}
	return out;
}

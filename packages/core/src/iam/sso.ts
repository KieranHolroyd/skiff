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
	domains: Iterable<T>,
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
export function hasSsoVerificationRecord(records: readonly (readonly string[])[], token: string): boolean {
	const expected = ssoVerificationRecord(token);
	for (const record of records) {
		if (record.join('').trim() === expected) return true;
	}
	return false;
}

/** A row is due when it has never been checked, or its last check is a day old. */
export function ssoDomainCheckDue(lastCheckedAt: number | null, now: number, interval = SSO_RECHECK_MS): boolean {
	return lastCheckedAt === null || now - lastCheckedAt >= interval;
}

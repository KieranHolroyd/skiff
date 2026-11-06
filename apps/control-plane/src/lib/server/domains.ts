/**
 * Shared-domain detection (DESIGN §5, D19). Deployed content is same-site with the dashboard when
 * the two hostnames share a registrable domain, e.g. `control.example.com` + `example.com`, or
 * `cloud.example.com` + `sites.example.com`. Either case needs the persistent warning.
 */

/** Second-level labels that act as public suffixes under a two-letter ccTLD (`co.uk`, `com.au`). */
const CC_SECOND_LEVEL = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org', 'ltd', 'plc', 'me']);

/** Approximate registrable domain (eTLD+1) without shipping the full Public Suffix List. */
export function registrableDomain(hostname: string): string {
	const labels = hostname.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
	if (labels.length <= 2) return labels.join('.');
	const tld = labels.at(-1)!;
	const second = labels.at(-2)!;
	const take = tld.length === 2 && CC_SECOND_LEVEL.has(second) ? 3 : 2;
	return labels.slice(-take).join('.');
}

export function isSharedDomain(platformHost: string, contentDomain: string): boolean {
	const a = platformHost.toLowerCase().replace(/\.$/, '');
	const b = contentDomain.toLowerCase().replace(/\.$/, '');
	if (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
	// IPs and single-label hosts (`localhost`) only match exactly.
	if (/^[\d.:]+$/.test(a) || /^[\d.:]+$/.test(b) || !a.includes('.') || !b.includes('.')) return false;
	return registrableDomain(a) === registrableDomain(b);
}

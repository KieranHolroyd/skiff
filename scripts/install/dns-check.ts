/**
 * Installer DNS check: confirm the platform host, the content apex and the content wildcard
 * resolve before Caddy asks Let's Encrypt for certificates. Read-only; it never edits DNS.
 *
 * Lookups go to public resolvers (not the host's cache) so a re-check sees records as soon as
 * they propagate. The wildcard is probed with a fresh random label each time, so a cached
 * NXDOMAIN from an earlier check cannot hide a newly created `*` record.
 */
import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

export const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];

export interface DnsTarget {
	/** Name shown to the operator, e.g. `*.example.com`. */
	display: string;
	/** Name actually queried. */
	name: string;
}

export interface DnsResult extends DnsTarget {
	addresses: string[];
	/** `elsewhere`: resolves, but not to this server (expected behind a proxy such as Cloudflare). */
	status: 'ok' | 'elsewhere' | 'missing';
}

/** Resolve a name to its A and AAAA addresses; an empty list means it does not resolve. */
export type Lookup = (name: string) => Promise<string[]>;

export function dnsTargets(platformHost: string, contentDomain: string, probe = randomBytes(4).toString('hex')): DnsTarget[] {
	const targets: DnsTarget[] = [
		{ display: platformHost, name: platformHost },
		{ display: contentDomain, name: contentDomain },
		{ display: `*.${contentDomain}`, name: `yoal-dns-check-${probe}.${contentDomain}` },
	];
	return targets.filter((target, index) => targets.findIndex((other) => other.name === target.name) === index);
}

export async function checkDns(targets: DnsTarget[], lookup: Lookup, serverAddresses: string[]): Promise<DnsResult[]> {
	return Promise.all(
		targets.map(async (target) => {
			const addresses = await lookup(target.name).catch(() => []);
			const status: DnsResult['status'] = !addresses.length
				? 'missing'
				: !serverAddresses.length || addresses.some((address) => serverAddresses.includes(address))
					? 'ok'
					: 'elsewhere';
			return { ...target, addresses, status };
		}),
	);
}

/** `dig +short` output → addresses only (it also prints CNAME targets, which end in a dot). */
export function parseDigShort(output: string): string[] {
	return output
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => isIP(line) !== 0);
}

/** Lookup via `dig` against a public resolver. `run` returns stdout, or null on failure. */
export function digLookup(run: (cmd: string[]) => string | null, resolver = PUBLIC_RESOLVERS[0]!): Lookup {
	return async (name) =>
		['A', 'AAAA'].flatMap((type) =>
			parseDigShort(run(['dig', '+short', '+time=3', '+tries=2', type, name, `@${resolver}`]) ?? ''),
		);
}

/** Fallback when `dig` is not installed: Node's resolver pointed at public servers. */
export function resolverLookup(servers = PUBLIC_RESOLVERS): Lookup {
	const resolver = new Resolver({ timeout: 3000, tries: 2 });
	resolver.setServers(servers);
	return async (name) => {
		const [v4, v6] = await Promise.all([
			resolver.resolve4(name).catch(() => [] as string[]),
			resolver.resolve6(name).catch(() => [] as string[]),
		]);
		return [...v4, ...v6];
	};
}

/** Loopback, RFC 1918, CGNAT/Tailscale, link-local and ULA addresses never appear in public DNS. */
export function isPublicAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 4) {
		const [a, b] = address.split('.').map(Number) as [number, number];
		if (a === 10 || a === 127 || a === 0) return false;
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 192 && b === 168) return false;
		if (a === 169 && b === 254) return false;
		if (a === 100 && b >= 64 && b <= 127) return false;
		return true;
	}
	if (version === 6) {
		const lower = address.toLowerCase();
		return !(lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd'));
	}
	return false;
}

/** `hostname -I` output → this server's public addresses. */
export function parseServerAddresses(output: string): string[] {
	return output.split(/\s+/).filter((address) => address && isPublicAddress(address));
}

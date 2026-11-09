import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { isIpv4 } from '@yoal/contracts';

/**
 * Settings → Domains checks names against public DNS before moving the platform (D105): the root
 * helper only proves Caddy on this host answers for the new name, not that the world can reach it.
 * "This server" is every address we know it by: its interfaces, the IP the dashboard is served on
 * today, and whatever the current platform host resolves to (its public IP behind NAT).
 */

export type DnsStatus = 'here' | 'elsewhere' | 'missing';

export interface DnsProbe {
	/** What the operator should create (e.g. `*.example.com`). */
	display: string;
	addresses: string[];
	status: DnsStatus;
}

const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];
const TIMEOUT_MS = 4_000;

function resolver(): Resolver {
	const instance = new Resolver({ timeout: TIMEOUT_MS, tries: 2 });
	instance.setServers(PUBLIC_RESOLVERS);
	return instance;
}

async function lookup(name: string, using = resolver()): Promise<string[]> {
	const settle = (query: Promise<string[]>) => query.catch(() => [] as string[]);
	const [v4, v6] = await Promise.all([settle(using.resolve4(name)), settle(using.resolve6(name))]);
	return [...v4, ...v6];
}

/**
 * Non-loopback interface addresses, or none when they cannot be read. The control-plane unit runs
 * with `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` (no AF_NETLINK), and on Linux
 * getifaddrs() needs a netlink socket, so `networkInterfaces()` throws there. Callers fall back to
 * the platform host and DNS.
 */
export function interfaceAddresses(family?: 'IPv4' | 'IPv6', read = networkInterfaces): string[] {
	let interfaces: ReturnType<typeof networkInterfaces>;
	try {
		interfaces = read();
	} catch {
		return [];
	}
	const addresses: string[] = [];
	for (const entries of Object.values(interfaces))
		for (const entry of entries ?? [])
			if (!entry.internal && (!family || entry.family === family)) addresses.push(entry.address);
	return addresses;
}

export async function serverAddresses(currentPlatformHost: string): Promise<Set<string>> {
	const known = new Set<string>(interfaceAddresses());
	const host = currentPlatformHost.replace(/:\d+$/, '');
	if (isIpv4(host)) known.add(host);
	else if (host) for (const address of await lookup(host)) known.add(address);
	return known;
}

/** Check the dashboard host and the content wildcard (with a random label, so it proves `*`). */
export async function probeDomains(
	settings: { platformHost: string; contentDomain: string },
	known: Set<string>
): Promise<{ platform: DnsProbe | null; content: DnsProbe }> {
	const using = resolver();
	const status = (addresses: string[]): DnsStatus =>
		addresses.length === 0 ? 'missing' : addresses.some((address) => known.has(address)) ? 'here' : 'elsewhere';
	const probe = async (name: string, display: string): Promise<DnsProbe> => {
		const addresses = await lookup(name, using);
		return { display, addresses, status: status(addresses) };
	};
	const wildcard = `yoal-dns-check-${randomBytes(4).toString('hex')}.${settings.contentDomain}`;
	const [platform, content] = await Promise.all([
		isIpv4(settings.platformHost) ? Promise.resolve(null) : probe(settings.platformHost, settings.platformHost),
		probe(wildcard, `*.${settings.contentDomain}`)
	]);
	return { platform, content };
}

/** The address to tell people to point records at: the dashboard IP, else a public interface address. */
export function primaryAddress(known: Set<string>): string | null {
	const list = [...known];
	return list.find((address) => isIpv4(address) && !/^(10|127|169\.254|192\.168)\./.test(address) && !/^172\.(1[6-9]|2\d|3[01])\./.test(address))
		?? list.find(isIpv4)
		?? list[0]
		?? null;
}

import { Resolver } from 'node:dns/promises';

/**
 * MX resolution for outbound delivery (RFC 5321 §5.1, RFC 7505 null MX).
 *
 * Behind an interface so tests can point any domain at a local fake MX. Delivery is IPv4-only
 * unless enabled (EMAIL.md §3.1): we resolve A records ourselves and connect to the address, with
 * the MX hostname kept for SNI and logs.
 */

export interface MxRecord {
	exchange: string;
	priority: number;
}

export interface MailResolver {
	resolveMx(domain: string): Promise<MxRecord[]>;
	resolve4(host: string): Promise<string[]>;
	resolve6(host: string): Promise<string[]>;
}

export class SystemResolver implements MailResolver {
	private readonly resolver = new Resolver({ timeout: 5000, tries: 2 });
	resolveMx(domain: string) {
		return this.resolver.resolveMx(domain);
	}
	resolve4(host: string) {
		return this.resolver.resolve4(host);
	}
	resolve6(host: string) {
		return this.resolver.resolve6(host);
	}
}

export class DeliveryDnsError extends Error {
	constructor(
		message: string,
		/** `EBADDOMAIN` is permanent (no such domain, null MX); anything else is retried. */
		readonly code: 'EBADDOMAIN' | 'ETEMPDNS',
	) {
		super(message);
	}
}

export interface MxTarget {
	/** The MX hostname, for SNI and logs. */
	host: string;
	address: string;
	priority: number;
}

const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

function dnsCode(error: unknown): string {
	return (error as { code?: string })?.code ?? '';
}

async function addressesFor(resolver: MailResolver, host: string, ipv6: boolean): Promise<string[]> {
	const v4 = await resolver.resolve4(host).catch((error) => {
		if (NOT_FOUND.has(dnsCode(error))) return [] as string[];
		throw error;
	});
	if (!ipv6) return v4;
	const v6 = await resolver.resolve6(host).catch(() => [] as string[]);
	return [...v4, ...v6];
}

/**
 * The ordered list of addresses to try for a recipient domain. Equal priorities are shuffled so
 * load spreads across a provider's MX set. At most `limit` targets are returned.
 */
export async function resolveTargets(
	resolver: MailResolver,
	domain: string,
	options: { ipv6?: boolean; limit?: number } = {},
): Promise<MxTarget[]> {
	const limit = options.limit ?? 5;
	let records: MxRecord[];
	try {
		records = await resolver.resolveMx(domain);
	} catch (error) {
		if (dnsCode(error) === 'ENODATA') records = [];
		else if (NOT_FOUND.has(dnsCode(error))) throw new DeliveryDnsError(`${domain} does not exist`, 'EBADDOMAIN');
		else throw new DeliveryDnsError(`MX lookup for ${domain} failed: ${dnsCode(error) || String(error)}`, 'ETEMPDNS');
	}
	if (records.some((record) => record.exchange === '' || record.exchange === '.'))
		throw new DeliveryDnsError(`${domain} does not accept mail (null MX)`, 'EBADDOMAIN');

	// No MX: the domain itself is the implicit MX (RFC 5321 §5.1).
	const ordered =
		records.length === 0
			? [{ exchange: domain, priority: 0 }]
			: [...records].sort((a, b) => a.priority - b.priority || Math.random() - 0.5);

	const targets: MxTarget[] = [];
	let lastError: unknown = null;
	for (const record of ordered) {
		if (targets.length >= limit) break;
		try {
			for (const address of await addressesFor(resolver, record.exchange, options.ipv6 ?? false)) {
				targets.push({ host: record.exchange.replace(/\.$/, ''), address, priority: record.priority });
				if (targets.length >= limit) break;
			}
		} catch (error) {
			lastError = error;
		}
	}
	if (targets.length === 0) {
		if (lastError) throw new DeliveryDnsError(`address lookup for ${domain}'s MX failed`, 'ETEMPDNS');
		throw new DeliveryDnsError(`${domain} has no reachable mail server`, records.length === 0 ? 'EBADDOMAIN' : 'ETEMPDNS');
	}
	return targets;
}

/**
 * Per-provider traffic shaping (EMAIL.md §3.2).
 *
 * Large mailbox providers rate-limit by sending IP, and a new IP gets very little headroom. Each
 * recipient domain maps to a provider; a provider has a connection cap, a message rate, and a
 * back-off that grows each time it answers with a throttling reply and resets on the next success.
 * The numbers are deliberately conservative for a single fresh IP; a platform admin can raise them
 * later (they are plain data).
 */

export interface ProviderLimits {
	/** Concurrent SMTP connections to this provider. */
	connections: number;
	/** Messages per minute across those connections. */
	perMinute: number;
}

export interface ProviderRule {
	name: string;
	domains: RegExp;
	mx: RegExp;
	limits: ProviderLimits;
}

export const PROVIDERS: ProviderRule[] = [
	{
		name: 'google',
		domains: /^(gmail\.com|googlemail\.com)$/,
		mx: /(^|\.)(google\.com|googlemail\.com)$/,
		limits: { connections: 3, perMinute: 60 },
	},
	{
		name: 'microsoft',
		domains: /^(outlook|hotmail|live|msn)\.[a-z.]+$/,
		mx: /(^|\.)(protection\.outlook\.com|hotmail\.com|outlook\.com)$/,
		limits: { connections: 2, perMinute: 30 },
	},
	{
		name: 'yahoo',
		domains: /^(yahoo|ymail|rocketmail|aol)\.[a-z.]+$/,
		mx: /(^|\.)(yahoodns\.net|aol\.com)$/,
		limits: { connections: 2, perMinute: 30 },
	},
	{
		name: 'apple',
		domains: /^(icloud\.com|me\.com|mac\.com)$/,
		mx: /(^|\.)icloud\.com$/,
		limits: { connections: 2, perMinute: 30 },
	},
];

export const DEFAULT_LIMITS: ProviderLimits = { connections: 2, perMinute: 120 };

/** The shaping key for a recipient domain: a provider name, or the domain itself. */
export function providerFor(domain: string, mxHost?: string): { key: string; limits: ProviderLimits } {
	const lower = domain.toLowerCase();
	for (const rule of PROVIDERS) {
		if (rule.domains.test(lower) || (mxHost && rule.mx.test(mxHost.toLowerCase())))
			return { key: rule.name, limits: rule.limits };
	}
	return { key: `domain:${lower}`, limits: DEFAULT_LIMITS };
}

const BACKOFF_START_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

interface ProviderState {
	inFlight: number;
	/** Send timestamps (ms) in the last minute. */
	recent: number[];
	backoffMs: number;
	blockedUntil: number;
}

export class Shaper {
	private readonly state = new Map<string, ProviderState>();

	constructor(private readonly now: () => number = Date.now) {}

	private get(key: string): ProviderState {
		let entry = this.state.get(key);
		if (!entry) {
			entry = { inFlight: 0, recent: [], backoffMs: 0, blockedUntil: 0 };
			this.state.set(key, entry);
		}
		return entry;
	}

	/** How many more messages may go to this provider right now (0 when blocked or at cap). */
	budget(key: string, limits: ProviderLimits): number {
		const entry = this.get(key);
		const now = this.now();
		if (entry.blockedUntil > now) return 0;
		if (entry.inFlight >= limits.connections) return 0;
		entry.recent = entry.recent.filter((at) => now - at < 60_000);
		return Math.max(0, limits.perMinute - entry.recent.length);
	}

	open(key: string): void {
		this.get(key).inFlight += 1;
	}

	close(key: string): void {
		const entry = this.get(key);
		entry.inFlight = Math.max(0, entry.inFlight - 1);
	}

	sent(key: string): void {
		const entry = this.get(key);
		entry.recent.push(this.now());
		entry.backoffMs = 0;
	}

	/** The provider answered with a throttling reply: back off, doubling up to an hour. */
	throttled(key: string): number {
		const entry = this.get(key);
		entry.backoffMs = entry.backoffMs ? Math.min(entry.backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
		entry.blockedUntil = this.now() + entry.backoffMs;
		return entry.backoffMs;
	}

	blockedUntil(key: string): number {
		return this.get(key).blockedUntil;
	}
}

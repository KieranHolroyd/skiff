import { createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import {
	authorizeSend,
	normalizeAddress,
	policyOrgFromState,
	type EmailAuthorization,
	type MailState,
} from '@skiff/contracts';

/**
 * The pushed mail state, indexed, plus the local counters SMTP submission needs (EMAIL.md §5.3).
 *
 * The control plane is the source of truth for quotas; this only has to be close enough between
 * pushes. Daily counts start from the pushed `sentToday` and only ever grow until UTC midnight.
 */

export type MailCredential = MailState['credentials'][number];
export type MailDomain = MailState['domains'][number];

/** `scrypt$<salt>$<hash>`, as packages/core `hashPassword` writes it. */
export function verifyScrypt(password: string, stored: string): boolean {
	const [scheme, salt, hash] = stored.split('$');
	if (scheme !== 'scrypt' || !salt || !hash) return false;
	const expected = Buffer.from(hash, 'base64url');
	const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const AUTH_CACHE_MS = 10 * 60_000;

export class MailPolicy {
	private current: MailState | null = null;
	private domains = new Map<string, MailDomain>();
	private credentials = new Map<string, MailCredential>();
	private suppressed = new Map<string, Set<string>>();
	private platformSuppressed = new Set<string>();
	private daily = new Map<string, { day: string; count: number }>();
	private perSecond = new Map<string, number[]>();
	/** sha256(username:password) → expiry, so scrypt runs once per credential per 10 minutes. */
	private authCache = new Map<string, number>();

	constructor(private readonly now: () => number = Date.now) {}

	get state(): MailState | null {
		return this.current;
	}

	get generation(): number | null {
		return this.current?.generation ?? null;
	}

	load(state: MailState): void {
		this.current = state;
		this.domains = new Map(state.domains.map((domain) => [domain.name.toLowerCase(), domain]));
		this.credentials = new Map(state.credentials.map((credential) => [credential.username, credential]));
		this.suppressed = new Map(state.orgs.map((org) => [org.orgId, new Set(org.suppressed.map(normalizeAddress))]));
		this.platformSuppressed = new Set(state.platformSuppressed.map(normalizeAddress));
		const day = this.today();
		for (const org of state.orgs) {
			const local = this.daily.get(org.orgId);
			const count = local && local.day === day ? Math.max(local.count, org.sentToday) : org.sentToday;
			this.daily.set(org.orgId, { day, count });
		}
		// Credentials may have been revoked or rotated: drop cached successes.
		this.authCache.clear();
	}

	domain(name: string): MailDomain | null {
		return this.domains.get(name.toLowerCase()) ?? null;
	}

	authenticate(username: string, password: string): MailCredential | null {
		const credential = this.credentials.get(username);
		if (!credential) return null;
		const key = createHash('sha256').update(`${username}\0${password}`).digest('hex');
		const cached = this.authCache.get(key);
		if (cached && cached > this.now()) return credential;
		if (!verifyScrypt(password, credential.hash)) return null;
		this.authCache.set(key, this.now() + AUTH_CACHE_MS);
		return credential;
	}

	isSuppressed(orgId: string, address: string): boolean {
		const normalized = normalizeAddress(address);
		return this.platformSuppressed.has(normalized) || (this.suppressed.get(orgId)?.has(normalized) ?? false);
	}

	/** Add a suppression locally (a hard bounce seen here) until the next push carries it. */
	suppress(orgId: string, address: string): void {
		let set = this.suppressed.get(orgId);
		if (!set) {
			set = new Set();
			this.suppressed.set(orgId, set);
		}
		set.add(normalizeAddress(address));
	}

	authorize(
		credential: MailCredential,
		envelope: { from: string; recipients: string[]; sizeBytes: number },
	): EmailAuthorization {
		if (!this.current)
			return { ok: false, code: 'rate_limited', message: 'Mail service is starting; try again shortly.', temporary: true };
		const org = policyOrgFromState(this.current, credential.orgId);
		if (!org)
			return { ok: false, code: 'email_paused', message: 'Email is not enabled for this organisation.', temporary: false };
		return authorizeSend(
			org,
			{ ...envelope, allowedFromDomains: credential.allowedFromDomains },
			this.usage(credential.orgId),
			(address) => this.isSuppressed(credential.orgId, address),
		);
	}

	/** Count an accepted message against the org's quota and rate. */
	record(orgId: string): void {
		const day = this.today();
		const entry = this.daily.get(orgId);
		this.daily.set(orgId, { day, count: entry && entry.day === day ? entry.count + 1 : 1 });
		const now = this.now();
		const recent = (this.perSecond.get(orgId) ?? []).filter((at) => now - at < 1000);
		recent.push(now);
		this.perSecond.set(orgId, recent);
	}

	usage(orgId: string): { sentToday: number; sentLastSecond: number } {
		const entry = this.daily.get(orgId);
		const now = this.now();
		return {
			sentToday: entry && entry.day === this.today() ? entry.count : 0,
			sentLastSecond: (this.perSecond.get(orgId) ?? []).filter((at) => now - at < 1000).length,
		};
	}

	private today(): string {
		return new Date(this.now()).toISOString().slice(0, 10);
	}
}

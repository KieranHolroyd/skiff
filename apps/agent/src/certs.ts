import { checkServerIdentity, connect } from 'node:tls';
import { HEARTBEAT_CERTS_MAX } from '@yoal/contracts';

/** One served certificate: the SNI probed and its expiry (ISO 8601). */
export interface CertInfo {
	host: string;
	notAfter: string;
}

/**
 * Reads the leaf certificate's expiry for `servername`; null when nothing could be read. With
 * `matchHost`, also null unless the certificate's names cover `servername` (a custom domain must
 * have its own certificate, not whatever Caddy falls back to).
 */
export type CertReader = (servername: string, options?: { matchHost?: boolean }) => Promise<Date | null>;

/** One host to probe. `matchHost` is set for custom domains (see CertReader). */
export interface CertTarget {
	host: string;
	servername: string;
	matchHost?: boolean;
}

export const CERT_PROBE_INTERVAL_MS = 6 * 3_600_000;
/** After a probe that read nothing (e.g. Caddy still starting), retry sooner. */
const CERT_RETRY_MS = 10 * 60_000;
/**
 * A custom domain the control plane just sent is usually issued within a minute or two; probe it
 * every 2 minutes for its first half hour so it shows as `active` promptly.
 */
export const CERT_NEW_HOST_RETRY_MS = 2 * 60_000;
const NEW_HOST_WINDOW_MS = 30 * 60_000;
const PROBE_TIMEOUT_MS = 5_000;
/** A label under the content domain that never has a route; the wildcard cert answers for it. */
const WILDCARD_PROBE_LABEL = 'yoal-cert-probe';

/**
 * The hosts whose certificates this node serves: the content apex, the content wildcard (probed
 * through a label no site uses), the platform host when this node fronts the control plane, and
 * the verified custom domains in its desired state (capped to what a heartbeat carries).
 */
export function certProbeTargets(
	contentDomain: string | null,
	platformHost: string | null,
	customHosts: Iterable<string> = [],
): CertTarget[] {
	const targets: CertTarget[] = [];
	if (contentDomain) {
		targets.push({ host: contentDomain, servername: contentDomain });
		targets.push({ host: `*.${contentDomain}`, servername: `${WILDCARD_PROBE_LABEL}.${contentDomain}` });
	}
	if (platformHost && !targets.some((target) => target.servername === platformHost))
		targets.push({ host: platformHost, servername: platformHost });
	for (const raw of customHosts) {
		if (targets.length >= HEARTBEAT_CERTS_MAX) break;
		const host = raw.trim().toLowerCase().replace(/\.$/, '');
		if (!host || targets.some((target) => target.servername === host)) continue;
		targets.push({ host, servername: host, matchHost: true });
	}
	return targets;
}

/** TLS handshake against the local Caddy with the given SNI. Only the expiry is read. */
export function tlsCertReader(address: { host: string; port: number }, timeoutMs = PROBE_TIMEOUT_MS): CertReader {
	return (servername, options) =>
		new Promise((resolve) => {
			let settled = false;
			const done = (value: Date | null) => {
				if (settled) return;
				settled = true;
				socket.destroy();
				resolve(value);
			};
			// rejectUnauthorized is off on purpose: an expiring or misissued certificate is exactly
			// what this probe must still be able to read. Nothing is sent over the connection.
			const socket = connect({ host: address.host, port: address.port, servername, rejectUnauthorized: false }, () => {
				const cert = socket.getPeerCertificate();
				if (options?.matchHost && (!cert || !cert.subject || checkServerIdentity(servername, cert) !== undefined))
					return done(null);
				const notAfter = cert && typeof cert.valid_to === 'string' ? new Date(cert.valid_to) : null;
				done(notAfter && Number.isFinite(notAfter.getTime()) ? notAfter : null);
			});
			socket.setTimeout(timeoutMs, () => done(null));
			socket.on('error', () => done(null));
		});
}

/**
 * Cached certificate expiries for heartbeats. Probing runs in the background at most every
 * ~6 h, so a heartbeat never waits on a TLS handshake, and failures are non-fatal.
 */
export class CertProbe {
	private results: CertInfo[] = [];
	private nextProbeAt = 0;
	private inFlight: Promise<void> | null = null;
	/** Hosts covered by the last probe, and when each target was first seen. */
	private probed = new Set<string>();
	private readonly firstSeen = new Map<string, number>();

	constructor(
		private readonly targets: () => CertTarget[],
		private readonly read: CertReader,
		private readonly now: () => number = Date.now,
		private readonly intervalMs = CERT_PROBE_INTERVAL_MS,
	) {}

	/** The last results; starts a background refresh when they're due or a new host appeared. */
	current(): CertInfo[] {
		if (!this.inFlight && (this.now() >= this.nextProbeAt || this.targets().some((target) => !this.probed.has(target.host)))) {
			this.inFlight = this.probe()
				.catch(() => {
					this.nextProbeAt = this.now() + CERT_RETRY_MS;
				})
				.finally(() => {
					this.inFlight = null;
				});
		}
		return this.results;
	}

	/** Probe every target now (also used by tests). */
	async probe(): Promise<void> {
		const targets = this.targets();
		const now = this.now();
		for (const target of targets) if (!this.firstSeen.has(target.host)) this.firstSeen.set(target.host, now);
		for (const host of this.firstSeen.keys()) if (!targets.some((target) => target.host === host)) this.firstSeen.delete(host);
		this.probed = new Set(targets.map((target) => target.host));
		const results: CertInfo[] = [];
		for (const target of targets) {
			try {
				const notAfter = await this.read(target.servername, target.matchHost ? { matchHost: true } : undefined);
				if (notAfter) results.push({ host: target.host, notAfter: notAfter.toISOString() });
			} catch {
				/* non-fatal: the next probe retries */
			}
		}
		// Keep the previous reading for a host that failed this time rather than dropping it.
		for (const previous of this.results)
			if (!results.some((entry) => entry.host === previous.host) && targets.some((t) => t.host === previous.host))
				results.push(previous);
		this.results = results;
		const missing = targets.filter((t) => !results.some((r) => r.host === t.host));
		const newHostMissing = missing.some((t) => t.matchHost && now - (this.firstSeen.get(t.host) ?? now) < NEW_HOST_WINDOW_MS);
		this.nextProbeAt =
			this.now() +
			(missing.length === 0 || targets.length === 0
				? this.intervalMs
				: newHostMissing
					? Math.min(CERT_NEW_HOST_RETRY_MS, this.intervalMs)
					: Math.min(CERT_RETRY_MS, this.intervalMs));
	}
}

import { connect } from 'node:tls';

/** One served certificate: the SNI probed and its expiry (ISO 8601). */
export interface CertInfo {
	host: string;
	notAfter: string;
}

/** Reads the leaf certificate's expiry for `servername`; null when nothing could be read. */
export type CertReader = (servername: string) => Promise<Date | null>;

export const CERT_PROBE_INTERVAL_MS = 6 * 3_600_000;
/** After a probe that read nothing (e.g. Caddy still starting), retry sooner. */
const CERT_RETRY_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 5_000;
/** A label under the content domain that never has a route; the wildcard cert answers for it. */
const WILDCARD_PROBE_LABEL = 'skiff-cert-probe';

/**
 * The hosts whose certificates this node serves: the content apex, the content wildcard (probed
 * through a label no site uses) and the platform host when this node fronts the control plane.
 */
export function certProbeTargets(
	contentDomain: string | null,
	platformHost: string | null,
): Array<{ host: string; servername: string }> {
	const targets: Array<{ host: string; servername: string }> = [];
	if (contentDomain) {
		targets.push({ host: contentDomain, servername: contentDomain });
		targets.push({ host: `*.${contentDomain}`, servername: `${WILDCARD_PROBE_LABEL}.${contentDomain}` });
	}
	if (platformHost && !targets.some((target) => target.servername === platformHost))
		targets.push({ host: platformHost, servername: platformHost });
	return targets;
}

/** TLS handshake against the local Caddy with the given SNI. Only the expiry is read. */
export function tlsCertReader(address: { host: string; port: number }, timeoutMs = PROBE_TIMEOUT_MS): CertReader {
	return (servername) =>
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

	constructor(
		private readonly targets: () => Array<{ host: string; servername: string }>,
		private readonly read: CertReader,
		private readonly now: () => number = Date.now,
		private readonly intervalMs = CERT_PROBE_INTERVAL_MS,
	) {}

	/** The last results; starts a background refresh when they're due. */
	current(): CertInfo[] {
		if (!this.inFlight && this.now() >= this.nextProbeAt) {
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
		const results: CertInfo[] = [];
		for (const target of targets) {
			try {
				const notAfter = await this.read(target.servername);
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
		const complete = targets.length > 0 && targets.every((t) => results.some((r) => r.host === t.host));
		this.nextProbeAt = this.now() + (complete || targets.length === 0 ? this.intervalMs : CERT_RETRY_MS);
	}
}

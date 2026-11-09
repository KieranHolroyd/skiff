/**
 * Installer TLS check, the companion to `dns-check.ts`: after the agent starts, confirm Caddy
 * actually serves a certificate for the content wildcard.
 *
 * A DNS-01 token that is missing, revoked or scoped to the wrong zone does not stop the install:
 * DNS resolves, the agent is healthy and deploys succeed, and every site still returns Cloudflare
 * error 525 because the origin has no certificate for the hostname. Cached assets can even make a
 * broken origin look half-working, so the installer checks the origin itself instead of trusting
 * that certificates "will issue".
 */
import { randomBytes } from 'node:crypto';
import { checkServerIdentity, connect, type PeerCertificate } from 'node:tls';

/**
 * A label under the content domain that no site uses; the wildcard certificate answers for it and
 * no single-site certificate can, so a positive result means `*.<domain>` is really being served.
 */
export function wildcardProbeHost(contentDomain: string, probe = randomBytes(4).toString('hex')): string {
	const domain = contentDomain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
	return `skiff-tls-check-${probe}.${domain}`;
}

/**
 * The TLS port from `SKIFF_CADDY_LISTEN` (`:443,:80`). Port 80 is Caddy's redirect listener, so it
 * is skipped; the default is 443.
 */
export function tlsPortFromListen(listen: string | null | undefined): number {
	for (const entry of (listen ?? '').split(',')) {
		const match = /:(\d+)$/.exec(entry.trim());
		const port = match ? Number(match[1]) : 0;
		if (port > 0 && port !== 80) return port;
	}
	return 443;
}

export interface CertificateInfo {
	/** Whether the served leaf certificate is valid for the probed name. */
	covers: boolean;
	/** Leaf expiry as ISO 8601; null when nothing could be read. */
	notAfter: string | null;
}

/** SAN/CN matching (including wildcards), the same rules a browser applies. */
export function certificateCovers(servername: string, cert: PeerCertificate | null | undefined): boolean {
	if (!cert || !cert.subject) return false;
	try {
		return checkServerIdentity(servername, cert) === undefined;
	} catch {
		return false;
	}
}

export interface TlsProbeOptions {
	host: string;
	port: number;
	servername: string;
	timeoutMs?: number;
}

/**
 * Handshake with the local origin and report whether its certificate covers `servername`. Nothing
 * is requested over the connection; verification is off on purpose so a misissued certificate is
 * still readable.
 */
export function probeServedCertificate(options: TlsProbeOptions): Promise<CertificateInfo> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	return new Promise((resolve) => {
		let settled = false;
		let socket: ReturnType<typeof connect>;
		const finish = (value: CertificateInfo) => {
			if (settled) return;
			settled = true;
			socket?.destroy();
			resolve(value);
		};
		socket = connect(
			{
				host: options.host,
				port: options.port,
				servername: options.servername,
				rejectUnauthorized: false,
			},
			() => {
				const cert = socket.getPeerCertificate();
				const notAfter = cert && typeof cert.valid_to === 'string' ? new Date(cert.valid_to) : null;
				finish({
					covers: certificateCovers(options.servername, cert),
					notAfter: notAfter && Number.isFinite(notAfter.getTime()) ? notAfter.toISOString() : null,
				});
			},
		);
		socket.setTimeout(timeoutMs, () => finish({ covers: false, notAfter: null }));
		socket.on('error', () => finish({ covers: false, notAfter: null }));
	});
}

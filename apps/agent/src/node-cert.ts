import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';

/**
 * The node's self-signed identity for C2 mTLS (docs/CLUSTERING.md §4.3).
 *
 * Generated locally with the node's openssl, kept 0600 in the agent data directory, and never
 * sent anywhere. The control plane distributes only the certificate and its SHA-256 fingerprint;
 * peers pin the fingerprint, so no per-install CA is required for the interim path.
 */
export interface NodeCertificate {
	keyPem: string;
	certPem: string;
	fingerprint: string;
	expiresAt: string;
}

export class NodeCertificateManager {
	private cached: NodeCertificate | null = null;
	private attempted = false;

	constructor(
		private readonly dataDir: string,
		private readonly nodeId: string,
	) {}

	ensure(): NodeCertificate | null {
		if (this.cached) return this.cached;
		if (this.attempted) return null;
		this.attempted = true;
		const dir = join(this.dataDir, 'tls');
		const keyPath = join(dir, 'node.key');
		const certPath = join(dir, 'node.crt');
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			if (!existsSync(keyPath) || !existsSync(certPath)) this.generate(keyPath, certPath);
			const keyPem = readFileSync(keyPath, 'utf8');
			const certPem = readFileSync(certPath, 'utf8');
			const parsed = new X509Certificate(certPem);
			this.cached = {
				keyPem,
				certPem,
				fingerprint: normalizeFingerprint(parsed.fingerprint256),
				expiresAt: new Date(parsed.validTo).toISOString(),
			};
			return this.cached;
		} catch {
			return null;
		}
	}

	private generate(keyPath: string, certPath: string): void {
		const result = Bun.spawnSync({
			cmd: [
				'openssl',
				'req',
				'-x509',
				'-newkey',
				'ec',
				'-pkeyopt',
				'ec_paramgen_curve:prime256v1',
				'-nodes',
				'-days',
				'365',
				'-subj',
				`/CN=${this.nodeId}`,
				'-addext',
				`subjectAltName=URI:yoal://node/${this.nodeId}`,
				'-keyout',
				keyPath,
				'-out',
				certPath,
			],
			stdout: 'pipe',
			stderr: 'pipe',
		});
		if (result.exitCode !== 0) throw new Error('openssl could not generate the node certificate');
		chmodSync(keyPath, 0o600);
		chmodSync(certPath, 0o644);
	}
}

export function normalizeFingerprint(value: string): string {
	return value.replaceAll(':', '').toLowerCase();
}

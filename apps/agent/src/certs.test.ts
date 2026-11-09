import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HEARTBEAT_CERTS_MAX } from '@yoal/contracts';
import { CERT_NEW_HOST_RETRY_MS, CERT_PROBE_INTERVAL_MS, CertProbe, certProbeTargets, tlsCertReader } from './certs.ts';
import { parseCertProbe } from './config.ts';

describe('certProbeTargets', () => {
	test('probes the apex, the wildcard via an unused label, and the platform host', () => {
		expect(certProbeTargets('sites.test', 'control.test')).toEqual([
			{ host: 'sites.test', servername: 'sites.test' },
			{ host: '*.sites.test', servername: 'yoal-cert-probe.sites.test' },
			{ host: 'control.test', servername: 'control.test' },
		]);
		expect(certProbeTargets(null, null)).toEqual([]);
	});

	test('adds custom domains with a name check, deduplicated and capped', () => {
		expect(certProbeTargets('sites.test', null, ['App.Example.com.', 'app.example.com', 'sites.test'])).toEqual([
			{ host: 'sites.test', servername: 'sites.test' },
			{ host: '*.sites.test', servername: 'yoal-cert-probe.sites.test' },
			{ host: 'app.example.com', servername: 'app.example.com', matchHost: true },
		]);
		const many = Array.from({ length: HEARTBEAT_CERTS_MAX + 20 }, (_, index) => `d${index}.example.com`);
		expect(certProbeTargets('sites.test', 'control.test', many)).toHaveLength(HEARTBEAT_CERTS_MAX);
	});
});

describe('CertProbe', () => {
	test('reads in the background, caches, and re-probes only after the interval', async () => {
		let now = 1_000;
		let reads = 0;
		const probe = new CertProbe(
			() => certProbeTargets('sites.test', null),
			async () => {
				reads++;
				return new Date('2027-01-01T00:00:00Z');
			},
			() => now,
		);
		expect(probe.current()).toEqual([]);
		await Bun.sleep(0);
		const first = probe.current();
		expect(first).toEqual([
			{ host: 'sites.test', notAfter: '2027-01-01T00:00:00.000Z' },
			{ host: '*.sites.test', notAfter: '2027-01-01T00:00:00.000Z' },
		]);
		expect(reads).toBe(2);
		now += CERT_PROBE_INTERVAL_MS - 1;
		probe.current();
		await Bun.sleep(0);
		expect(reads).toBe(2);
		now += 1;
		probe.current();
		await Bun.sleep(0);
		expect(reads).toBe(4);
	});

	test('a new custom domain is probed at once, with the name check, then every 2 minutes until it has a certificate', async () => {
		let now = 1_000;
		let hosts: string[] = [];
		let issued = false;
		const reads: Array<{ servername: string; matchHost: boolean }> = [];
		const probe = new CertProbe(
			() => certProbeTargets('sites.test', null, hosts),
			async (servername, options) => {
				reads.push({ servername, matchHost: options?.matchHost === true });
				if (servername === 'app.example.com' && !issued) return null;
				return new Date('2027-01-01T00:00:00Z');
			},
			() => now,
		);
		probe.current();
		await Bun.sleep(0);
		expect(reads).toHaveLength(2);

		// The control plane sends a verified domain: the next heartbeat probes without waiting 6 h.
		hosts = ['app.example.com'];
		now += 60_000;
		probe.current();
		await Bun.sleep(0);
		expect(reads.at(-1)).toEqual({ servername: 'app.example.com', matchHost: true });
		expect(probe.current().map((cert) => cert.host)).toEqual(['sites.test', '*.sites.test']);
		const count = reads.length;

		now += CERT_NEW_HOST_RETRY_MS - 1;
		probe.current();
		await Bun.sleep(0);
		expect(reads).toHaveLength(count);
		issued = true;
		now += 1;
		probe.current();
		await Bun.sleep(0);
		expect(probe.current().map((cert) => cert.host)).toContain('app.example.com');
	});

	test('failures are non-fatal and keep the last good reading', async () => {
		let fail = false;
		const probe = new CertProbe(
			() => certProbeTargets('sites.test', null),
			async () => {
				if (fail) throw new Error('connection refused');
				return new Date('2027-01-01T00:00:00Z');
			},
			() => 0,
			0,
		);
		await probe.probe();
		fail = true;
		await probe.probe();
		expect(probe.current().map((cert) => cert.host)).toEqual(['sites.test', '*.sites.test']);
	});
});

describe('parseCertProbe', () => {
	test('defaults to loopback on the TLS listen port, only with TLS', () => {
		expect(parseCertProbe(undefined, [':443', ':80'], true)).toEqual({ host: '127.0.0.1', port: 443 });
		expect(parseCertProbe(undefined, [':80', '10.0.0.1:8443'], true)).toEqual({ host: '10.0.0.1', port: 8443 });
		expect(parseCertProbe(undefined, [':443', ':80'], false)).toBeNull();
		expect(parseCertProbe('off', [':443'], true)).toBeNull();
		expect(parseCertProbe('127.0.0.1:9443', [':443'], false)).toEqual({ host: '127.0.0.1', port: 9443 });
		expect(() => parseCertProbe('nope', [':443'], true)).toThrow(/YOAL_CERT_PROBE_ADDR/);
	});
});

const openssl = Bun.which('openssl');

describe('tlsCertReader', () => {
	test.skipIf(!openssl)('reads notAfter from a real TLS handshake, even for an untrusted cert', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-certs-'));
		try {
			const result = Bun.spawnSync([
				openssl!,
				'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '10',
				'-subj', '/CN=sites.test',
				'-keyout', join(dir, 'key.pem'),
				'-out', join(dir, 'cert.pem'),
			]);
			expect(result.exitCode).toBe(0);
			const server = createServer({
				key: readFileSync(join(dir, 'key.pem')),
				cert: readFileSync(join(dir, 'cert.pem')),
			});
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			const port = (server.address() as { port: number }).port;
			try {
				const notAfter = await tlsCertReader({ host: '127.0.0.1', port })('sites.test');
				expect(notAfter).not.toBeNull();
				const days = (notAfter!.getTime() - Date.now()) / 86_400_000;
				expect(days).toBeGreaterThan(9);
				expect(days).toBeLessThan(11);
			} finally {
				server.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.skipIf(!openssl)('with matchHost, only a certificate naming the host counts', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-certs-'));
		try {
			const result = Bun.spawnSync([
				openssl!,
				'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '10',
				'-subj', '/CN=app.example.com',
				'-addext', 'subjectAltName=DNS:app.example.com',
				'-keyout', join(dir, 'key.pem'),
				'-out', join(dir, 'cert.pem'),
			]);
			expect(result.exitCode).toBe(0);
			const server = createServer({
				key: readFileSync(join(dir, 'key.pem')),
				cert: readFileSync(join(dir, 'cert.pem')),
			});
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			const port = (server.address() as { port: number }).port;
			try {
				const read = tlsCertReader({ host: '127.0.0.1', port });
				expect(await read('app.example.com', { matchHost: true })).not.toBeNull();
				// Caddy answering another name with this certificate is not "serving" that name.
				expect(await read('other.example.com', { matchHost: true })).toBeNull();
				expect(await read('other.example.com')).not.toBeNull();
			} finally {
				server.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('returns null when nothing is listening', async () => {
		expect(await tlsCertReader({ host: '127.0.0.1', port: 1 }, 500)('sites.test')).toBeNull();
	});
});

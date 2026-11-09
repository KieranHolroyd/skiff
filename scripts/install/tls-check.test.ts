import { describe, expect, test } from 'bun:test';
import type { PeerCertificate } from 'node:tls';
import {
	certificateCovers,
	probeServedCertificate,
	tlsPortFromListen,
	wildcardProbeHost,
} from './tls-check.ts';

function cert(subjectaltname: string, commonName = 'example.com'): PeerCertificate {
	return { subject: { CN: commonName }, subjectaltname } as unknown as PeerCertificate;
}

describe('installer TLS check', () => {
	test('probes the wildcard through a fresh unused label', () => {
		expect(wildcardProbeHost('ExampleCloud.com.', 'abcd')).toBe('skiff-tls-check-abcd.examplecloud.com');
		expect(wildcardProbeHost('examplecloud.com', 'a')).not.toBe(wildcardProbeHost('examplecloud.com', 'b'));
	});

	test('reads the TLS port from SKIFF_CADDY_LISTEN', () => {
		expect(tlsPortFromListen(':443,:80')).toBe(443);
		expect(tlsPortFromListen(':8443,:80')).toBe(8443);
		expect(tlsPortFromListen(':80')).toBe(443);
		expect(tlsPortFromListen('')).toBe(443);
		expect(tlsPortFromListen(undefined)).toBe(443);
	});

	test('the wildcard certificate covers the probe label', () => {
		expect(certificateCovers('skiff-tls-check-abcd.example.com', cert('DNS:*.example.com, DNS:example.com'))).toBe(true);
	});

	test('an apex-only certificate does not cover the probe label', () => {
		expect(certificateCovers('skiff-tls-check-abcd.example.com', cert('DNS:example.com'))).toBe(false);
	});

	test('a wildcard covers exactly one label', () => {
		expect(certificateCovers('a.skiff-tls-check.example.com', cert('DNS:*.example.com'))).toBe(false);
	});

	test('an exact certificate for the probe label is accepted', () => {
		expect(certificateCovers('skiff-tls-check-abcd.example.com', cert('DNS:skiff-tls-check-abcd.example.com'))).toBe(true);
	});

	test('a certificate for another domain is rejected', () => {
		expect(certificateCovers('skiff-tls-check-abcd.example.com', cert('DNS:*.other.test'))).toBe(false);
	});

	test('no certificate (handshake failure) is not coverage', () => {
		expect(certificateCovers('skiff-tls-check-abcd.example.com', null)).toBe(false);
		expect(certificateCovers('skiff-tls-check-abcd.example.com', {} as PeerCertificate)).toBe(false);
	});

	test('a closed port reports no certificate instead of throwing', async () => {
		const result = await probeServedCertificate({
			host: '127.0.0.1',
			port: 9,
			servername: 'skiff-tls-check-abcd.example.com',
			timeoutMs: 1_000,
		});
		expect(result).toEqual({ covers: false, notAfter: null });
	});
});

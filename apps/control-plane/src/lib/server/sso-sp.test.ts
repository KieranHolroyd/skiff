import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { X509Certificate, createPublicKey } from 'node:crypto';
import { decrypt, encrypt, randomBytes } from '../../../../../packages/core/src/util.ts';
import {
	SSO_SP_ROLLOVER_MS,
	SsoSpKeyStore,
	generateSsoSpSigningKey,
	ssoSpCertificateFromKey
} from './sso-sp';

/**
 * SP signing keys (IAM.md I19, §8.3): generation, the self-signed certificate, and the sealed
 * round-trip through `settings`. The store is exercised with the same encrypt/decrypt primitive
 * `SecretService` uses, a real in-memory SQLite table and a controllable clock, so no IdP or
 * control-plane singleton is involved.
 */

const db = new Database(':memory:');
db.run(
	'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
);

const masterKey = randomBytes(32);
const secrets = {
	seal(_orgId: string, value: string): string {
		const encrypted = encrypt(masterKey, new TextEncoder().encode(value));
		return `${encrypted.nonce}.${encrypted.ciphertext}`;
	},
	open(_orgId: string, sealed: string): string {
		const [nonce, ciphertext] = sealed.split('.');
		if (!nonce || !ciphertext) throw new Error('malformed');
		return new TextDecoder().decode(decrypt(masterKey, ciphertext, nonce));
	}
};

let now = 1_700_000_000_000;
let store: InstanceType<typeof SsoSpKeyStore>;

beforeEach(() => {
	db.run('DELETE FROM settings');
	now = 1_700_000_000_000;
	store = new SsoSpKeyStore({ sqlite: db, secrets, now: () => now });
});

describe('SP signing key generation', () => {
	test('generates an RSA key whose certificate matches its public key', () => {
		const key = generateSsoSpSigningKey('Skiff SAML sso_test', now);
		expect(key.privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
		expect(key.certificatePem.startsWith('-----BEGIN CERTIFICATE-----')).toBe(true);

		const certificate = new X509Certificate(key.certificatePem);
		expect(certificate.subject).toContain('CN=Skiff SAML sso_test');
		expect(certificate.publicKey.export({ type: 'spki', format: 'pem' })).toBe(
			createPublicKey(key.privateKeyPem).export({ type: 'spki', format: 'pem' })
		);
	});

	test('re-derives the certificate from the same key', () => {
		const key = generateSsoSpSigningKey('Skiff SAML sso_test', now);
		const rederived = ssoSpCertificateFromKey(key.privateKeyPem, 'Skiff SAML sso_test', now);
		expect(new X509Certificate(rederived).publicKey.export({ type: 'spki', format: 'pem' })).toBe(
			new X509Certificate(key.certificatePem).publicKey.export({ type: 'spki', format: 'pem' })
		);
	});
});

describe('SP key storage', () => {
	test('seals the private key, publishes only the certificate, and reopens the same key', () => {
		const first = store.ensure('sso_store');
		expect(first.privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);

		const raw = db
			.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
			.get('sso.sp.sso_store')!.value;
		expect(raw).not.toContain('BEGIN PRIVATE KEY');
		expect(raw).not.toContain(first.privateKeyPem);
		expect(JSON.parse(raw).certificatePem).toBe(first.certificatePem);

		const reopened = store.ensure('sso_store');
		expect(reopened.privateKeyPem).toBe(first.privateKeyPem);
		expect(reopened.certificatePem).toBe(first.certificatePem);
		expect(store.view('sso_store')).toEqual({
			certificate: first.certificatePem,
			previousCertificate: null,
			createdAt: now,
			previousPublishedUntil: null
		});
	});

	test('rotation publishes the previous certificate for the overlap window', () => {
		const first = store.ensure('sso_store');
		now += 1_000;
		const rotated = store.rotate('sso_store');
		expect(rotated.privateKeyPem).not.toBe(first.privateKeyPem);

		const view = store.view('sso_store')!;
		expect(view.certificate).toBe(rotated.certificatePem);
		expect(view.previousCertificate).toBe(first.certificatePem);
		expect(view.previousPublishedUntil).toBe(now + SSO_SP_ROLLOVER_MS);

		now += SSO_SP_ROLLOVER_MS + 1;
		expect(store.view('sso_store')?.previousCertificate).toBeNull();
		expect(store.view('sso_store')?.previousPublishedUntil).toBeNull();
	});

	test('removing a provider removes its key material', () => {
		store.ensure('sso_store');
		store.remove('sso_store');
		expect(store.view('sso_store')).toBeNull();
		expect(
			db
				.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
				.get('sso.sp.sso_store')
		).toBeNull();
	});
});

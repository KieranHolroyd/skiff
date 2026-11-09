/**
 * SAML service-provider keys (IAM.md I19, §8.3).
 *
 * `@better-auth/sso` signs AuthnRequests and logout messages with an SP private key, and decrypts
 * encrypted assertions with a second SP key. The keys belong to one provider: an organisation has
 * at most one provider in this slice, and keeping them per provider means deleting and re-adding an
 * IdP gets fresh key material instead of inheriting an old trust relationship.
 *
 * Storage: one `settings` row per provider and purpose (`sso.sp.<providerId>` for signing,
 * `sso.spEnc.<providerId>` for assertion encryption). The private key is PKCS#8 PEM sealed with the
 * platform key (`core.ctx.secrets`, the same key `shares`/`github-app` use); the certificate is
 * public and stored beside it. A rotation keeps the previous certificate, and the previous sealed
 * key, until the overlap window ends so the IdP can be updated without a gap.
 *
 * The encryption key is deliberately separate from the signing key: an IdP imports the encryption
 * certificate to encrypt assertions to Skiff, and reusing a signing key for that would make one
 * compromise break both roles. The encryption certificate advertises RSA-OAEP (the IdP chooses the
 * key transport from the certificate copied from SP metadata).
 *
 * Signing-key generation happens at boot (`syncSsoProviders`) and on the explicit rotate action.
 * Encryption-key generation happens when the provider enables assertion encryption and on its
 * explicit rotate action; the sync only reads it, so a missing or unreadable key fails closed.
 * Reading a view never creates a key.
 */
import type { Database } from 'bun:sqlite';
import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomBytes,
	sign
} from 'node:crypto';

/** The settings-key prefix for a provider's SP signing key material. */
export const SSO_SP_SETTINGS_PREFIX = 'sso.sp.';

/** The settings-key prefix for a provider's SP assertion-encryption key material. */
export const SSO_SP_ENCRYPTION_SETTINGS_PREFIX = 'sso.spEnc.';

/** Which role a store manages; they are separate keys and separate settings rows. */
export type SsoSpKeyPurpose = 'signing' | 'encryption';

/** `secrets.seal` is scoped to an org; platform-wide material uses the synthetic platform key. */
const PLATFORM_KEY_ORG = 'platform';

/** How long a rotated-out certificate stays published (and usable by the IdP). */
export const SSO_SP_ROLLOVER_MS = 30 * 24 * 60 * 60 * 1000;

export interface SsoSpSigningKey {
	/** PKCS#8 private key, PEM. Never returned to the browser or written in the clear. */
	privateKeyPem: string;
	/** Self-signed X.509 certificate over the same key. */
	certificatePem: string;
}

/** The same key-pair shape is used for signing and for assertion encryption. */
export type SsoSpKeyPair = SsoSpSigningKey;

/**
 * A provider has assertion encryption enabled but its sealed encryption key is absent or cannot be
 * opened. The sync catches this and removes the plugin row, so sign-in fails closed rather than
 * silently generating a new key the IdP does not trust.
 */
export class SsoSpKeyUnavailableError extends Error {
	constructor(providerId: string, purpose: SsoSpKeyPurpose, cause?: unknown) {
		super(
			`The sealed SAML SP ${purpose} key for provider ${providerId} is ${
				cause ? 'unreadable' : 'missing'
			}. Rotate it in Settings → SSO before enabling sign-in again.`,
			{ cause }
		);
		this.name = 'SsoSpKeyUnavailableError';
	}
}

/** What Settings may show: public material only. */
export interface SsoSpKeyView {
	certificate: string;
	/** The previous certificate while it is still inside its rollover window. */
	previousCertificate: string | null;
	createdAt: number;
	previousPublishedUntil: number | null;
}

export interface SsoSpKeyMaterial extends SsoSpKeyView {
	privateKeyPem: string;
	/** Alias of `certificate`, named for the plugin's field. */
	certificatePem: string;
}

interface StoredSpKey {
	privateKeySealed: string;
	certificatePem: string;
	createdAt: number;
	previous?: {
		privateKeySealed: string;
		certificatePem: string;
		publishedUntil: number;
	};
}

interface SsoSpKeyStoreOptions {
	sqlite: Pick<Database, 'query' | 'run'>;
	secrets: {
		seal(orgId: string, value: string): string;
		open(orgId: string, value: string): string;
	};
	now?: () => number;
	/** Defaults to `signing`; encryption keys live under a different settings prefix. */
	purpose?: SsoSpKeyPurpose;
}

export function spKeySettingsKey(providerId: string): string {
	return `${SSO_SP_SETTINGS_PREFIX}${providerId}`;
}

export function spEncryptionKeySettingsKey(providerId: string): string {
	return `${SSO_SP_ENCRYPTION_SETTINGS_PREFIX}${providerId}`;
}

// -------------------------------------------------------------------------------------- DER / X.509

function derLength(n: number): Buffer {
	if (n < 0x80) return Buffer.from([n]);
	const bytes: number[] = [];
	for (let value = n; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
	const body = Buffer.concat(parts);
	return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);

function oid(dotted: string): Buffer {
	const [a, b, ...rest] = dotted.split('.').map(Number);
	const bytes = [a! * 40 + b!];
	for (const value of rest) {
		const chunk: number[] = [value & 0x7f];
		for (let v = Math.floor(value / 128); v > 0; v = Math.floor(v / 128))
			chunk.unshift((v & 0x7f) | 0x80);
		bytes.push(...chunk);
	}
	return tlv(0x06, Buffer.from(bytes));
}

function integer(bytes: Buffer): Buffer {
	let value = bytes;
	while (value.length > 1 && value[0] === 0 && (value[1]! & 0x80) === 0) value = value.subarray(1);
	if (value[0]! & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
	return tlv(0x02, value);
}

function time(date: Date): Buffer {
	const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
	// UTCTime until 2049, GeneralizedTime from 2050 (RFC 5280 §4.1.2.5).
	return date.getUTCFullYear() < 2050
		? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`))
		: tlv(0x18, Buffer.from(`${iso}Z`));
}

function name(commonName: string): Buffer {
	return sequence(set(sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));
}

/** A minimal self-signed X.509 v3 certificate (sha256WithRSAEncryption) over `spki`. */
function selfSignedRsaCertificate(
	privateKeyPem: string,
	spki: Buffer,
	commonName: string,
	now: number
): string {
	// sha256WithRSAEncryption (RFC 8017), with the NULL parameters X.509 expects.
	const algorithm = sequence(oid('1.2.840.113549.1.1.11'), tlv(0x05, Buffer.alloc(0)));
	const subject = name(commonName);
	const notBefore = new Date(now - 60_000);
	const notAfter = new Date(now + 10 * 365 * 24 * 3600_000);
	const tbs = sequence(
		tlv(0xa0, integer(Buffer.from([2]))),
		integer(randomBytes(16)),
		algorithm,
		subject,
		sequence(time(notBefore), time(notAfter)),
		subject,
		spki
	);
	const signature = sign('sha256', tbs, { key: createPrivateKey(privateKeyPem) });
	const der = sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
	const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
	return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/**
 * Generate an RSA-2048 SP key and its self-signed certificate. RSA is deliberate: samlify's SP
 * request signer defaults to `rsa-sha256`, and most IdPs publish and accept RSA SP certificates.
 */
export function generateSsoSpSigningKey(commonName: string, now = Date.now()): SsoSpSigningKey {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
	const spki = publicKey.export({ type: 'spki', format: 'der' });
	return {
		privateKeyPem,
		certificatePem: selfSignedRsaCertificate(privateKeyPem, spki, commonName, now)
	};
}

/**
 * Generate the separate RSA key an IdP encrypts assertions to. RSA-OAEP is a key-transport choice
 * made by the IdP from the published certificate; the key pair itself is RSA (the same primitive
 * samlify and every IdP accept for XML Encryption). It is never the signing key.
 */
export function generateSsoSpEncryptionKey(commonName: string, now = Date.now()): SsoSpKeyPair {
	return generateSsoSpSigningKey(commonName, now);
}

/** Re-derive the certificate for an existing key (used by tests and key recovery). */
export function ssoSpCertificateFromKey(
	privateKeyPem: string,
	commonName: string,
	now = Date.now()
): string {
	const spki = createPublicKey(createPrivateKey(privateKeyPem)).export({
		type: 'spki',
		format: 'der'
	});
	return selfSignedRsaCertificate(privateKeyPem, spki, commonName, now);
}

// ---------------------------------------------------------------------------------------- store

export class SsoSpKeyStore {
	readonly #sqlite: Pick<Database, 'query' | 'run'>;
	readonly #secrets: SsoSpKeyStoreOptions['secrets'];
	readonly #now: () => number;
	readonly #purpose: SsoSpKeyPurpose;
	readonly #settingsKey: (providerId: string) => string;
	readonly #generate: (commonName: string, now: number) => SsoSpKeyPair;

	constructor(options: SsoSpKeyStoreOptions) {
		this.#sqlite = options.sqlite;
		this.#secrets = options.secrets;
		this.#now = options.now ?? Date.now;
		this.#purpose = options.purpose ?? 'signing';
		this.#settingsKey =
			this.#purpose === 'encryption' ? spEncryptionKeySettingsKey : spKeySettingsKey;
		this.#generate =
			this.#purpose === 'encryption' ? generateSsoSpEncryptionKey : generateSsoSpSigningKey;
	}

	/** The stored key, or null when this provider has never had one. Never generates. */
	view(providerId: string): SsoSpKeyView | null {
		const stored = this.#read(providerId);
		if (!stored) return null;
		const now = this.#now();
		const previous =
			stored.previous && stored.previous.publishedUntil > now
				? {
						certificate: stored.previous.certificatePem,
						previousPublishedUntil: stored.previous.publishedUntil
					}
				: { certificate: null, previousPublishedUntil: null };
		return {
			certificate: stored.certificatePem,
			previousCertificate: previous.certificate,
			createdAt: stored.createdAt,
			previousPublishedUntil: previous.previousPublishedUntil
		};
	}

	/** Open the key for the plugin; generates and seals the first key if the provider has none. */
	ensure(providerId: string, commonName?: string): SsoSpKeyMaterial {
		const stored = this.#read(providerId);
		if (stored) return this.#material(providerId, stored);
		const now = this.#now();
		const generated = this.#generate(commonName ?? this.#commonName(providerId), now);
		const next: StoredSpKey = {
			privateKeySealed: this.#seal(generated.privateKeyPem),
			certificatePem: generated.certificatePem,
			createdAt: now
		};
		this.#write(providerId, next);
		return this.#material(providerId, next);
	}

	/**
	 * Open the stored key without generating one. The sync uses this for assertion encryption so a
	 * provider that says it is encrypted cannot silently get a new certificate the IdP never saw.
	 */
	require(providerId: string): SsoSpKeyMaterial {
		const stored = this.#read(providerId);
		if (!stored) throw new SsoSpKeyUnavailableError(providerId, this.#purpose);
		return this.#material(providerId, stored);
	}

	/**
	 * Re-key a provider. The old key and certificate stay published for the rollover window; the
	 * new key signs (or decrypts) from now on, so an IdP that still trusts the old certificate keeps
	 * working until it is updated.
	 */
	rotate(providerId: string, commonName?: string): SsoSpKeyMaterial {
		const current = this.#read(providerId) ?? null;
		const now = this.#now();
		const generated = this.#generate(commonName ?? this.#commonName(providerId), now);
		const next: StoredSpKey = {
			privateKeySealed: this.#seal(generated.privateKeyPem),
			certificatePem: generated.certificatePem,
			createdAt: now,
			...(current
				? {
						previous: {
							privateKeySealed: current.privateKeySealed,
							certificatePem: current.certificatePem,
							publishedUntil: now + SSO_SP_ROLLOVER_MS
						}
					}
				: {})
		};
		this.#write(providerId, next);
		return this.#material(providerId, next);
	}

	/** Remove a provider's key material when the provider is deleted or the toggle is turned off. */
	remove(providerId: string): void {
		this.#sqlite.run('DELETE FROM settings WHERE key = ?', [this.#settingsKey(providerId)]);
	}

	#commonName(providerId: string): string {
		return this.#purpose === 'encryption'
			? `Skiff SAML ${providerId} encryption`
			: `Skiff SAML ${providerId}`;
	}

	#read(providerId: string): StoredSpKey | null {
		let raw: string | undefined;
		try {
			raw = this.#sqlite
				.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
				.get(this.#settingsKey(providerId))?.value;
		} catch {
			return null; // settings table not created yet (first boot)
		}
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw) as Partial<StoredSpKey>;
			if (typeof parsed.privateKeySealed !== 'string' || typeof parsed.certificatePem !== 'string')
				return null;
			if (typeof parsed.createdAt !== 'number') return null;
			const previous =
				parsed.previous &&
				typeof parsed.previous.privateKeySealed === 'string' &&
				typeof parsed.previous.certificatePem === 'string' &&
				typeof parsed.previous.publishedUntil === 'number'
					? {
							privateKeySealed: parsed.previous.privateKeySealed,
							certificatePem: parsed.previous.certificatePem,
							publishedUntil: parsed.previous.publishedUntil
						}
					: undefined;
			return {
				privateKeySealed: parsed.privateKeySealed,
				certificatePem: parsed.certificatePem,
				createdAt: parsed.createdAt,
				...(previous ? { previous } : {})
			};
		} catch {
			return null;
		}
	}

	#write(providerId: string, stored: StoredSpKey): void {
		this.#sqlite.run(
			'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
			[this.#settingsKey(providerId), JSON.stringify(stored), this.#now()]
		);
	}

	#material(providerId: string, stored: StoredSpKey): SsoSpKeyMaterial {
		const previous =
			stored.previous && stored.previous.publishedUntil > this.#now()
				? {
						previousCertificate: stored.previous.certificatePem,
						previousPublishedUntil: stored.previous.publishedUntil
					}
				: { previousCertificate: null, previousPublishedUntil: null };
		let privateKeyPem: string;
		try {
			privateKeyPem = this.#open(stored.privateKeySealed);
		} catch (cause) {
			throw new SsoSpKeyUnavailableError(providerId, this.#purpose, cause);
		}
		return {
			privateKeyPem,
			certificate: stored.certificatePem,
			certificatePem: stored.certificatePem,
			createdAt: stored.createdAt,
			...previous
		};
	}

	#seal(value: string): string {
		return this.#secrets.seal(PLATFORM_KEY_ORG, value);
	}

	#open(value: string): string {
		return this.#secrets.open(PLATFORM_KEY_ORG, value);
	}
}

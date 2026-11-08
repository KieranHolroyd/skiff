import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * Registry tokens (docs/REGISTRY.md R6): the control plane is the Docker token realm and signs
 * short-lived ES256 JWTs; zot verifies them against a certificate the helper writes into its
 * config. zot reads an X.509 certificate, so this file also builds a minimal self-signed one.
 *
 * Token shape (Docker token spec): `iss`, `sub`, `aud` = the registry service, `exp`/`nbf`/`iat`,
 * `jti`, and `access: [{ type: 'repository', name, actions }]`.
 */

export interface RegistrySigningKey {
	/** PKCS#8 PEM. Sealed at rest by the caller. */
	privateKeyPem: string;
	/** Self-signed X.509 PEM over the same key, for zot's `http.auth.bearer.cert`. */
	certificatePem: string;
}

export interface RegistryAccess {
	type: 'repository' | 'registry';
	name: string;
	actions: string[];
}

export function generateRegistrySigningKey(commonName: string, now = Date.now()): RegistrySigningKey {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
	const spki = publicKey.export({ type: 'spki', format: 'der' });
	return { privateKeyPem, certificatePem: selfSignedCertificate(privateKeyPem, spki, commonName, now) };
}

function base64url(input: Buffer | string): string {
	return Buffer.from(input).toString('base64url');
}

/** An ES256 JWT for the registry. `ttlSeconds` defaults to five minutes. */
export function signRegistryToken(
	key: Pick<RegistrySigningKey, 'privateKeyPem'>,
	claims: { issuer: string; service: string; subject: string; access: RegistryAccess[]; ttlSeconds?: number },
	now = Date.now(),
): { token: string; expiresIn: number; issuedAt: string } {
	const iat = Math.floor(now / 1000);
	const expiresIn = claims.ttlSeconds ?? 300;
	const header = { alg: 'ES256', typ: 'JWT', kid: keyId(key.privateKeyPem) };
	const payload = {
		iss: claims.issuer,
		sub: claims.subject,
		aud: claims.service,
		iat,
		nbf: iat - 30,
		exp: iat + expiresIn,
		jti: randomBytes(12).toString('hex'),
		access: claims.access,
	};
	const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
	const signature = sign('sha256', Buffer.from(input), {
		key: createPrivateKey(key.privateKeyPem),
		dsaEncoding: 'ieee-p1363',
	});
	return { token: `${input}.${base64url(signature)}`, expiresIn, issuedAt: new Date(iat * 1000).toISOString() };
}

/** A short stable key id: the first 16 hex of the public key's SPKI hash. */
function keyId(privateKeyPem: string): string {
	const spki = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'der' });
	return new Bun.CryptoHasher('sha256').update(spki).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------------------- DER

function length(n: number): Buffer {
	if (n < 0x80) return Buffer.from([n]);
	const bytes: number[] = [];
	for (let value = n; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
	const body = Buffer.concat(parts);
	return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);

function oid(dotted: string): Buffer {
	const [a, b, ...rest] = dotted.split('.').map(Number);
	const bytes = [a! * 40 + b!];
	for (const value of rest) {
		const chunk: number[] = [value & 0x7f];
		for (let v = Math.floor(value / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
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
	return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

function name(commonName: string): Buffer {
	return sequence(set(sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));
}

/** A minimal self-signed X.509 v3 certificate (ecdsa-with-SHA256) over `spki`. */
export function selfSignedCertificate(privateKeyPem: string, spki: Buffer, commonName: string, now = Date.now()): string {
	const algorithm = sequence(oid('1.2.840.10045.4.3.2'));
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
		spki,
	);
	const signature = sign('sha256', tbs, { key: createPrivateKey(privateKeyPem), dsaEncoding: 'der' });
	const der = sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
	const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
	return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

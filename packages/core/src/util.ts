import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	randomBytes,
	randomUUID,
	scryptSync,
	timingSafeEqual,
} from 'node:crypto';

export const newId = (prefix = ''): string => `${prefix}${randomUUID().replace(/-/g, '')}`;

const SHORT_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
/** 10-char lowercase base32 (`<slug>--<shortid>`); ~50 bits, collision-checked on insert. */
export function shortId(length = 10): string {
	const bytes = randomBytes(length);
	let out = '';
	for (let i = 0; i < length; i++) out += SHORT_ALPHABET[bytes[i]! % SHORT_ALPHABET.length];
	return out;
}

export const sha256Hex = (data: string | Uint8Array): string =>
	createHash('sha256').update(data).digest('hex');

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export { randomBytes };

export const hmac = (secret: string | Uint8Array, value: string): string =>
	createHmac('sha256', secret).update(value).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

/** scrypt password hashing for `password` access mode; format `scrypt$<salt>$<hash>`. */
export function hashPassword(password: string): string {
	const salt = randomBytes(16);
	const hash = scryptSync(password, salt, 32);
	return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
	if (!stored) return false;
	const [scheme, saltText, hashText] = stored.split('$');
	if (scheme !== 'scrypt' || !saltText || !hashText) return false;
	const expected = Buffer.from(hashText, 'base64url');
	const actual = scryptSync(password, Buffer.from(saltText, 'base64url'), expected.length);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** AES-256-GCM envelope helper. */
export function encrypt(key: Uint8Array, plaintext: Uint8Array): { ciphertext: string; nonce: string } {
	const nonce = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, nonce);
	const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return {
		ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
		nonce: nonce.toString('base64'),
	};
}

export function decrypt(key: Uint8Array, ciphertext: string, nonce: string): Uint8Array {
	const data = Buffer.from(ciphertext, 'base64');
	const tag = data.subarray(data.length - 16);
	const body = data.subarray(0, data.length - 16);
	const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'));
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(body), decipher.final()]);
}

export interface AccessTokenClaims {
	/** Content host the token is valid for. */
	host: string;
	/** Expiry, seconds since epoch. */
	exp: number;
	/** Subject: user id or share redemption id. */
	sub: string;
	kind: 'platform' | 'share' | 'password' | 'access';
	/** The verified address, so the agent can hand `Yoal-Access-Email` upstream. */
	email?: string;
	/** Session/redemption id, used for revocation. */
	sid?: string;
	/** Session expiry: the agent copies this into the host-only cookie (longer than `exp`). */
	sexp?: number;
	/** One-time callback id; the agent refuses a replay. */
	jti?: string;
}

export function signAccessToken(secret: string, claims: AccessTokenClaims): string {
	const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
	return `${payload}.${hmac(secret, payload)}`;
}

export function verifyAccessToken(secret: string, token: string): AccessTokenClaims | null {
	const [payload, signature] = token.split('.');
	if (!payload || !signature) return null;
	if (!safeEqual(hmac(secret, payload), signature)) return null;
	try {
		const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as AccessTokenClaims;
		if (typeof claims.host !== 'string' || typeof claims.exp !== 'number') return null;
		if (claims.exp <= Math.floor(Date.now() / 1000)) return null;
		return claims;
	} catch {
		return null;
	}
}

/** Stable visitor id: never store a raw IP (DESIGN §8). */
export const hashVisitor = (secret: string, ip: string, userAgent: string): string =>
	hmac(secret, `${ip}|${userAgent}`).slice(0, 32);

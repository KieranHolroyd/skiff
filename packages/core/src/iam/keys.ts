/**
 * The platform signing-key ring (docs/IAM.md I15, §4, §7.3).
 *
 * Every token Skiff mints is signed by one ring, keyed by purpose (`sts`, `registry`, `oidc`,
 * `workload`, `pool:<id>`), so there is one issuer and one public JWKS. Keys are ES256 (P-256)
 * generated with WebCrypto (or Node crypto on the synchronous path), and only the public JWK is
 * stored in the clear: the private JWK is sealed with the platform master key (the same `encrypt`
 * helper `secrets.ts` uses).
 *
 * Rotation is next → active → retired:
 *
 *   ensure(purpose)  creates the first `active` key when the ring is empty.
 *   rotate(purpose)  publishes a fresh `next`, promotes the previous `next` to `active`, and
 *                    retires the previous `active`. When there is no previous `next` (the first
 *                    rotation after `ensure`) the existing `active` keeps signing and the new key
 *                    waits as `next`, so one call is always safe and never leaves a purpose with
 *                    no signer. The caller is expected to leave a `next` published for 24 hours
 *                    before rotating again; that cadence is policy, not a prerequisite for safety.
 *
 * A retired key stays in JWKS until `retire_after` (the longest token TTL this code can mint, one
 * hour, plus a 24-hour margin). `verify` still accepts a retired key so a token signed moments
 * before rotation validates.
 *
 * The registry realm and pipeline OIDC are ring consumers too (I15). Their APIs predate the ring
 * and are synchronous (`RegistryService.issueToken`, `PipelineOidc.mint`), so the ring offers a
 * synchronous signer beside the async one: both read the same `signing_keys` rows, seal keys the
 * same way and produce ES256 tokens. `activePrivateKeyPem` exists only so the registry can derive
 * zot's X.509 certificate from the active ring key (zot reads a certificate, not a JWKS).
 *
 * Pipeline OIDC keeps its `<origin>/api/pipeline/oidc` issuer as an alias (§7.3, D162), so `sign`
 * and `signSync` accept an issuer override. Its old settings key stays published in its JWKS until
 * the overlap ends.
 */
import type { Database } from 'bun:sqlite';
import { createHash, createPrivateKey, sign as cryptoSign, generateKeyPairSync } from 'node:crypto';
import type { Principal } from '@skiff/contracts';
import type { CoreContext } from '../context.ts';
import { ValidationError } from '../errors.ts';
import { decrypt, encrypt } from '../util.ts';

export type SigningKeyState = 'next' | 'active' | 'retired';
export type SigningKeyPurpose = 'sts' | 'registry' | 'oidc' | 'workload' | `pool:${string}` | (string & {});

/** The public half of a key, safe to publish. The private JWK is never returned. */
export interface SigningKeyRecord {
	kid: string;
	alg: string;
	purpose: string;
	state: SigningKeyState;
	publicJwk: Record<string, unknown>;
	createdAt: number;
	activatedAt: number | null;
	retireAfter: number | null;
}

export interface RotationResult {
	purpose: string;
	/** The key that signs from now on. */
	active: SigningKeyRecord;
	/** The newly published key, or null when the new key itself became active. */
	next: SigningKeyRecord | null;
	/** The key that stopped signing in this rotation, if any. */
	retiredKid: string | null;
}

export interface JwtClaims {
	iss: string;
	aud: string | string[];
	sub: string;
	iat: number;
	exp: number;
	[key: string]: unknown;
}

/** Optional overrides for minting. Pipeline OIDC keeps its legacy path-based issuer (§7.3). */
export interface SignOptions {
	issuer?: string;
}

export class SigningKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SigningKeyError';
	}
}

/** The longest token this service is expected to sign (STS, `sts.ts`) is one hour. */
const MAX_SIGNED_TTL_SECONDS = 60 * 60;
/** Retired keys stay in JWKS for the longest token TTL plus this margin (docs/IAM.md §7.3). */
const RETIRE_MARGIN_MS = 24 * 60 * 60_000;
/** Clock skew tolerated when verifying `exp` / `nbf` / `iat`. */
const SKEW_SECONDS = 60;
const ALG = 'ES256';

interface SigningKeyRow {
	kid: string;
	alg: string;
	purpose: string;
	public_jwk: string;
	private_sealed: string;
	state: string;
	created_at: number;
	activated_at: number | null;
	retire_after: number | null;
}

interface GeneratedKey {
	kid: string;
	publicJwk: Record<string, unknown>;
	privateSealed: string;
}

function base64url(input: Uint8Array | string): string {
	return Buffer.from(input).toString('base64url');
}

function decodePart<T>(part: string, what: string): T {
	try {
		return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
	} catch {
		throw new SigningKeyError(`The token's ${what} is not valid JSON.`);
	}
}

/** Keep only the public members of an EC JWK, so a private `d` can never leak into JWKS. */
function publicMembers(jwk: Record<string, unknown>): Record<string, unknown> {
	const { kty, crv, x, y } = jwk;
	if (typeof kty !== 'string' || typeof crv !== 'string' || typeof x !== 'string' || typeof y !== 'string')
		throw new SigningKeyError('The generated key did not export a P-256 public JWK.');
	return { kty, crv, x, y };
}

export class SigningKeyService {
	readonly #sqlite: Database;
	/** Decrypted private keys, keyed by `kid`. Rotation drops only the affected purpose. */
	readonly #privateKeys = new Map<string, CryptoKey>();
	/** The same keys as Node `KeyObject`s, for the synchronous signer. */
	readonly #nodeKeys = new Map<string, ReturnType<typeof createPrivateKey>>();

	constructor(private readonly ctx: CoreContext) {
		this.#sqlite = ctx.sqlite;
	}

	/** The single issuer every purpose shares: the platform origin (docs/IAM.md §7.3). */
	issuer(): string {
		return this.ctx.config.platformOrigin;
	}

	// ---------------------------------------------------------------- the ring

	/** Create the first key for a purpose, or promote a waiting `next` when there is no active. */
	async ensure(purpose: string): Promise<SigningKeyRecord> {
		return this.ensureSync(purpose);
	}

	/** The synchronous form of `ensure` (registry and pipeline OIDC predate the async ring API). */
	ensureSync(purpose: string): SigningKeyRecord {
		const active = this.row(purpose, 'active');
		if (active) return view(active);

		const next = this.row(purpose, 'next');
		if (next) {
			this.#sqlite.run('UPDATE signing_keys SET state = ?, activated_at = ? WHERE kid = ?', [
				'active',
				this.ctx.now(),
				next.kid,
			]);
			return view(this.requireRow(next.kid));
		}

		const generated = this.generateSync();
		// Another caller may have created an active key while this one generated. Use theirs.
		const raced = this.row(purpose, 'active');
		if (raced) return view(raced);
		const now = this.ctx.now();
		this.#sqlite.run(
			`INSERT INTO signing_keys
			   (kid, alg, purpose, public_jwk, private_sealed, state, created_at, activated_at, retire_after)
			 VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
			[generated.kid, ALG, purpose, JSON.stringify(generated.publicJwk), generated.privateSealed, now, now],
		);
		return view(this.requireRow(generated.kid));
	}

	/**
	 * Publish a new key and advance the ring (see the file header). Safe in one call: an existing
	 * active key is never removed until a replacement has been promoted.
	 */
	async rotate(purpose: string, principal?: Principal): Promise<RotationResult> {
		const now = this.ctx.now();
		const active = this.row(purpose, 'active');
		const next = this.row(purpose, 'next');
		const generated = await this.generate();
		const retireAfter = now + MAX_SIGNED_TTL_SECONDS * 1000 + RETIRE_MARGIN_MS;

		let freshState: SigningKeyState = 'next';
		let retiredKid: string | null = null;
		this.#sqlite.transaction(() => {
			if (!active) {
				if (next) {
					// A waiting key was already published: promote it and let the fresh key wait.
					this.#sqlite.run('UPDATE signing_keys SET state = ?, activated_at = ? WHERE kid = ?', [
						'active',
						now,
						next.kid,
					]);
					freshState = 'next';
				} else {
					// Nothing was signing: the new key must take over immediately.
					freshState = 'active';
				}
			} else if (next) {
				// Normal rotation: next becomes active, active retires, fresh waits as next.
				this.#sqlite.run('UPDATE signing_keys SET state = ?, activated_at = ? WHERE kid = ?', [
					'active',
					now,
					next.kid,
				]);
				this.#sqlite.run('UPDATE signing_keys SET state = ?, retire_after = ? WHERE kid = ?', [
					'retired',
					retireAfter,
					active.kid,
				]);
				retiredKid = active.kid;
				freshState = 'next';
			} else {
				// First rotation after `ensure`: keep the active key and publish the next one.
				freshState = 'next';
			}

			this.#sqlite.run(
				`INSERT INTO signing_keys
				   (kid, alg, purpose, public_jwk, private_sealed, state, created_at, activated_at, retire_after)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
				[
					generated.kid,
					ALG,
					purpose,
					JSON.stringify(generated.publicJwk),
					generated.privateSealed,
					freshState,
					now,
					freshState === 'active' ? now : null,
				],
			);
			// Older retired rows keep their window; a row that never got one gets it now.
			this.#sqlite.run(
				`UPDATE signing_keys SET retire_after = ?
				  WHERE purpose = ? AND state = 'retired' AND retire_after IS NULL`,
				[retireAfter, purpose],
			);
		})();

		const activeRow = this.row(purpose, 'active');
		if (!activeRow) throw new SigningKeyError(`No active signing key for "${purpose}" after rotation.`);
		const nextRow = this.row(purpose, 'next');
		this.ctx.audit.record({
			principal,
			action: 'iam.key.rotate',
			resource: 'signing_key',
			resourceId: generated.kid,
			args: {
				purpose,
				kid: generated.kid,
				state: freshState,
				active: activeRow.kid,
				retired: retiredKid,
			},
			result: 'ok',
		});

		return {
			purpose,
			active: view(activeRow),
			next: nextRow ? view(nextRow) : null,
			retiredKid,
		};
	}

	/** The key that signs now; creates or repairs the ring on first use. */
	async active(purpose: string): Promise<SigningKeyRecord> {
		return this.activeSync(purpose);
	}

	/** The synchronous form of `active`. */
	activeSync(purpose: string): SigningKeyRecord {
		const row = this.row(purpose, 'active');
		return row ? view(row) : this.ensureSync(purpose);
	}

	/**
	 * The active private key as PKCS#8 PEM. Only for consumers that need X.509 — the registry
	 * derives zot's self-signed certificate from it; nothing else should export private material.
	 */
	activePrivateKeyPem(purpose: string): { kid: string; privateKeyPem: string } {
		const key = this.activeSync(purpose);
		const privateKey = this.nodeKey(key);
		return {
			kid: key.kid,
			privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
		};
	}

	/** One key by purpose and kid. Retired keys remain resolvable so their tokens still verify. */
	byKid(purpose: string, kid: string): SigningKeyRecord | null {
		const row = this.#sqlite
			.query<SigningKeyRow, [string, string]>('SELECT * FROM signing_keys WHERE purpose = ? AND kid = ?')
			.get(purpose, kid);
		return row ? view(row) : null;
	}

	/** One key by kid alone, for callers that do not yet know the purpose (STS subject tokens). */
	findByKid(kid: string): SigningKeyRecord | null {
		const row = this.#sqlite
			.query<SigningKeyRow, [string]>('SELECT * FROM signing_keys WHERE kid = ?')
			.get(kid);
		return row ? view(row) : null;
	}

	/** Every purpose in the ring, for the shared discovery document. */
	purposes(): string[] {
		return this.#sqlite
			.query<{ purpose: string }, []>('SELECT DISTINCT purpose FROM signing_keys ORDER BY purpose')
			.all()
			.map((row) => row.purpose);
	}

	/**
	 * Published keys for one purpose: `next` and `active` always, and `retired` while its
	 * `retire_after` window is open (docs/IAM.md §7.3).
	 */
	jwks(purpose: string): Array<Record<string, unknown>> {
		const now = this.ctx.now();
		return this.#sqlite
			.query<SigningKeyRow, [string]>('SELECT * FROM signing_keys WHERE purpose = ? ORDER BY created_at')
			.all(purpose)
			.filter((row) => row.state !== 'retired' || row.retire_after === null || row.retire_after > now)
			.map((row) => ({
				...parseJwk(row.public_jwk),
				kid: row.kid,
				alg: row.alg,
				use: 'sig',
			}));
	}

	/**
	 * The shared JWKS document. Every purpose is published under the platform issuer except
	 * `pool:*`, which have their own issuers in Part B (docs/IAM.md §7.3).
	 */
	jwksAll(): { keys: Array<Record<string, unknown>> } {
		const keys = this.purposes()
			.filter((purpose) => !purpose.startsWith('pool:'))
			.flatMap((purpose) => this.jwks(purpose));
		// A kid is unique, so two purposes returning the same row (only possible after a purpose
		// rename) still publish it once.
		const seen = new Set<string>();
		return {
			keys: keys.filter((key) => {
				const kid = String(key.kid ?? '');
				if (seen.has(kid)) return false;
				seen.add(kid);
				return true;
			}),
		};
	}

	// ---------------------------------------------------------------- tokens

	/**
	 * Sign an ES256 JWT with the purpose's active key. `iss` defaults to the platform origin;
	 * pipeline OIDC passes its path-based issuer so existing cloud trusts keep working (§7.3).
	 */
	async sign(
		purpose: string,
		claims: { sub: string; aud: string | string[]; [claim: string]: unknown },
		ttlSeconds: number,
		options: SignOptions = {},
	): Promise<string> {
		if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)
			throw new ValidationError('A token TTL must be a positive number of seconds.');
		const key = await this.active(purpose);
		const privateKey = await this.privateKey(key);
		const iat = Math.floor(this.ctx.now() / 1000);
		const payload = {
			...claims,
			iss: options.issuer ?? this.issuer(),
			iat,
			exp: iat + Math.floor(ttlSeconds),
		};
		const header = { alg: ALG, typ: 'JWT', kid: key.kid };
		const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
		const signature = await crypto.subtle.sign(
			{ name: 'ECDSA', hash: 'SHA-256' },
			privateKey,
			new TextEncoder().encode(input),
		);
		return `${input}.${base64url(new Uint8Array(signature))}`;
	}

	/**
	 * The synchronous signer, for callers whose public API predates the ring (the registry realm
	 * and pipeline OIDC). Same keys, same claims, same ES256 encoding as `sign`.
	 */
	signSync(
		purpose: string,
		claims: { sub: string; aud: string | string[]; [claim: string]: unknown },
		ttlSeconds: number,
		options: SignOptions = {},
	): string {
		if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)
			throw new ValidationError('A token TTL must be a positive number of seconds.');
		const key = this.activeSync(purpose);
		const privateKey = this.nodeKey(key);
		const iat = Math.floor(this.ctx.now() / 1000);
		const payload = {
			...claims,
			iss: options.issuer ?? this.issuer(),
			iat,
			exp: iat + Math.floor(ttlSeconds),
		};
		const header = { alg: ALG, typ: 'JWT', kid: key.kid };
		const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
		const signature = cryptoSign('sha256', Buffer.from(input), {
			key: privateKey,
			dsaEncoding: 'ieee-p1363',
		});
		return `${input}.${signature.toString('base64url')}`;
	}

	/**
	 * Verify a token signed by this purpose. The signature, issuer, expiry and (when `audience`
	 * is given) audience are checked; the claims are returned. Retired keys still verify, because
	 * their tokens may be inside their TTL when a rotation happens.
	 */
	async verify(
		purpose: string,
		token: string,
		options: { audience?: string; issuer?: string } = {},
	): Promise<JwtClaims> {
		const { header, claims, input, signature } = parseJwt(token);
		if (header.alg !== ALG) throw new SigningKeyError(`Unsupported token algorithm ${header.alg ?? 'none'}.`);
		const kid = typeof header.kid === 'string' ? header.kid : '';
		if (!kid) throw new SigningKeyError('The token has no key id.');
		const key = this.byKid(purpose, kid);
		if (!key) throw new SigningKeyError(`No signing key "${kid}" for "${purpose}".`);
		const publicKey = await crypto.subtle.importKey(
			'jwk',
			key.publicJwk as never,
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify'],
		);
		const ok = await crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			publicKey,
			signature as never,
			input as never,
		);
		if (!ok) throw new SigningKeyError('The token signature does not verify.');
		assertClaims(claims, { ...options, issuer: options.issuer ?? this.issuer() }, this.ctx.now());
		return claims;
	}

	// ---------------------------------------------------------------- internals

	private async generate(): Promise<GeneratedKey> {
		const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
			'sign',
			'verify',
		])) as CryptoKeyPair;
		const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as Record<string, unknown>;
		const publicJwk = publicMembers(
			(await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, unknown>,
		);
		// RFC 7638 thumbprint: a stable, public kid derived from the key itself.
		const thumbprint = `${base64url(
			new Uint8Array(
				await crypto.subtle.digest(
					'SHA-256',
					new TextEncoder().encode(
						JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y }),
					),
				),
			),
		)}`;
		const kid = `k_${thumbprint}`;
		const sealed = encrypt(this.ctx.config.masterKey, new TextEncoder().encode(JSON.stringify(privateJwk)));
		return {
			kid,
			publicJwk,
			privateSealed: JSON.stringify({ nonce: sealed.nonce, ciphertext: sealed.ciphertext }),
		};
	}

	/** Synchronous generation, for the sync signer; `rotate` keeps the async path. */
	private generateSync(): GeneratedKey {
		const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
		const privateJwk = privateKey.export({ format: 'jwk' }) as Record<string, unknown>;
		const publicJwk = publicMembers(publicKey.export({ format: 'jwk' }) as Record<string, unknown>);
		// RFC 7638 thumbprint: a stable, public kid derived from the key itself.
		const thumbprint = createHash('sha256')
			.update(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y }))
			.digest('base64url');
		const kid = `k_${thumbprint}`;
		const sealed = encrypt(this.ctx.config.masterKey, new TextEncoder().encode(JSON.stringify(privateJwk)));
		return {
			kid,
			publicJwk,
			privateSealed: JSON.stringify({ nonce: sealed.nonce, ciphertext: sealed.ciphertext }),
		};
	}

	/** The decrypted private JWK for one key. */
	private privateJwk(key: SigningKeyRecord): Record<string, unknown> {
		const row = this.requireRow(key.kid);
		let sealed: { nonce: string; ciphertext: string };
		try {
			sealed = JSON.parse(row.private_sealed) as { nonce: string; ciphertext: string };
		} catch {
			throw new SigningKeyError(`Signing key "${key.kid}" has a malformed sealed private key.`);
		}
		if (!sealed.nonce || !sealed.ciphertext)
			throw new SigningKeyError(`Signing key "${key.kid}" has a malformed sealed private key.`);
		const jwk = new TextDecoder().decode(
			decrypt(this.ctx.config.masterKey, sealed.ciphertext, sealed.nonce),
		);
		try {
			return JSON.parse(jwk) as Record<string, unknown>;
		} catch {
			throw new SigningKeyError(`Signing key "${key.kid}" does not decrypt to a JWK.`);
		}
	}

	private async privateKey(key: SigningKeyRecord): Promise<CryptoKey> {
		const cached = this.#privateKeys.get(key.kid);
		if (cached) return cached;
		const privateKey = await crypto.subtle.importKey(
			'jwk',
			this.privateJwk(key) as never,
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['sign'],
		);
		this.#privateKeys.set(key.kid, privateKey);
		return privateKey;
	}

	private nodeKey(key: SigningKeyRecord): ReturnType<typeof createPrivateKey> {
		const cached = this.#nodeKeys.get(key.kid);
		if (cached) return cached;
		const privateKey = createPrivateKey({ key: this.privateJwk(key) as never, format: 'jwk' });
		this.#nodeKeys.set(key.kid, privateKey);
		return privateKey;
	}

	private row(purpose: string, state: SigningKeyState): SigningKeyRow | null {
		return (
			this.#sqlite
				.query<SigningKeyRow, [string, string]>(
					'SELECT * FROM signing_keys WHERE purpose = ? AND state = ? ORDER BY created_at DESC LIMIT 1',
				)
				.get(purpose, state) ?? null
		);
	}

	private requireRow(kid: string): SigningKeyRow {
		const row = this.#sqlite
			.query<SigningKeyRow, [string]>('SELECT * FROM signing_keys WHERE kid = ?')
			.get(kid);
		if (!row) throw new SigningKeyError(`Signing key "${kid}" disappeared.`);
		return row;
	}
}

// ------------------------------------------------------------------------- helpers

function view(row: SigningKeyRow): SigningKeyRecord {
	return {
		kid: row.kid,
		alg: row.alg,
		purpose: row.purpose,
		state: row.state as SigningKeyState,
		publicJwk: parseJwk(row.public_jwk),
		createdAt: row.created_at,
		activatedAt: row.activated_at,
		retireAfter: row.retire_after,
	};
}

function parseJwk(json: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(json);
		if (!value || typeof value !== 'object') throw new Error('not an object');
		return value as Record<string, unknown>;
	} catch {
		throw new SigningKeyError('A signing key has a malformed public JWK.');
	}
}

function parseJwt(token: string): {
	header: { alg?: string; kid?: string; typ?: string };
	claims: JwtClaims;
	input: Uint8Array;
	signature: Uint8Array;
} {
	const parts = token.split('.');
	if (parts.length !== 3) throw new SigningKeyError('Not a JWT.');
	const [headerPart, bodyPart, signaturePart] = parts as [string, string, string];
	const header = decodePart<{ alg?: string; kid?: string; typ?: string }>(headerPart, 'header');
	const raw = decodePart<Record<string, unknown>>(bodyPart, 'payload');
	const claims = normalizeClaims(raw);
	return {
		header,
		claims,
		input: new TextEncoder().encode(`${headerPart}.${bodyPart}`),
		signature: new Uint8Array(Buffer.from(signaturePart, 'base64url')),
	};
}

function normalizeClaims(raw: Record<string, unknown>): JwtClaims {
	const iss = typeof raw.iss === 'string' ? raw.iss : '';
	const sub = typeof raw.sub === 'string' ? raw.sub : '';
	const aud =
		typeof raw.aud === 'string'
			? raw.aud
			: Array.isArray(raw.aud)
				? raw.aud.filter((value): value is string => typeof value === 'string')
				: [];
	const iat = typeof raw.iat === 'number' ? raw.iat : 0;
	const exp = typeof raw.exp === 'number' ? raw.exp : 0;
	return { ...raw, iss, sub, aud, iat, exp };
}

function assertClaims(
	claims: JwtClaims,
	options: { audience?: string; issuer?: string },
	nowMs: number,
): void {
	const now = Math.floor(nowMs / 1000);
	const issuer = options.issuer ?? claims.iss;
	if (!claims.iss || claims.iss !== issuer) throw new SigningKeyError('The token was issued by someone else.');
	if (!Array.isArray(claims.aud) || claims.aud.length === 0) {
		if (typeof claims.aud !== 'string' || !claims.aud) throw new SigningKeyError('The token has no audience.');
	}
	if (options.audience) {
		const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (!audiences.includes(options.audience))
			throw new SigningKeyError(`The token's audience must be ${options.audience}.`);
	}
	if (!claims.exp || claims.exp + SKEW_SECONDS < now) throw new SigningKeyError('The token has expired.');
	const nbf = typeof claims.nbf === 'number' ? claims.nbf : undefined;
	if (nbf !== undefined && nbf - SKEW_SECONDS > now) throw new SigningKeyError('The token is not valid yet.');
	if (claims.iat && claims.iat - SKEW_SECONDS > now) throw new SigningKeyError('The token was issued in the future.');
}

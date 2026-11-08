/**
 * The token service (docs/IAM.md I16–I17, §7.3): RFC 8693 token exchange.
 *
 * A caller presents a subject token. It may be:
 *
 *   - a Skiff token signed by the signing-key ring (`sts`, `workload` or `oidc` purpose),
 *   - a Skiff pipeline OIDC token (the legacy `<platform>/api/pipeline/oidc` issuer, kept until
 *     the registry realm and pipeline OIDC move onto the ring),
 *   - a GitHub Actions OIDC token, or
 *   - any OIDC token whose `iss` matches an enabled `federation_trusts` row.
 *
 * External issuers are verified with RS256 or ES256 against the issuer's published JWKS. A
 * matching trust names one service account; the exchange mints a ≤1-hour (default 15-minute)
 * ES256 access token for it, signed by the `sts` purpose of the ring and narrowed by the trust's
 * `restriction_json` and the caller's optional `scope`.
 *
 * TODO(I4 follow-up): once the registry realm (`registry-token.ts`) and pipeline OIDC
 * (`pipeline-oidc.ts`) are moved onto `signingKeys`, delete the legacy branch below and accept
 * those tokens through the ring alone. The registry realm should then also accept an STS token.
 */
import type { Database } from 'bun:sqlite';
import { isPermission } from '@skiff/contracts';
import type { CoreContext } from '../context.ts';
import { PipelineOidc } from '../pipeline-oidc.ts';
import { parseJson } from '../util.ts';

export const TOKEN_EXCHANGE_GRANT =
	'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
export const JWT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt';
export const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';

/** GitHub publishes its keys at a path without the `.json` suffix. */
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const DEFAULT_TTL_SECONDS = 15 * 60;
const MAX_TTL_SECONDS = 60 * 60;
const SKEW_SECONDS = 60;
const JWKS_TIMEOUT_MS = 10_000;

export type StsErrorCode = 'invalid_request' | 'invalid_grant';

/** An RFC 8693 token-endpoint error. The route renders these as `{ error, error_description }`. */
export class StsError extends Error {
	constructor(
		readonly code: StsErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'StsError';
	}
}

export interface TokenExchangeInput {
	subjectToken: string;
	/** Requested audience of the minted token; defaults to the platform origin. */
	audience?: string;
	/** Space-separated permission names; can only narrow the trust's restriction. */
	scope?: string;
	/** Restrict matching to one federation trust, when the caller knows it. */
	trustId?: string;
}

export interface TokenExchangeResult {
	access_token: string;
	issued_token_type: typeof ACCESS_TOKEN_TYPE;
	token_type: 'Bearer';
	expires_in: number;
}

interface TrustRow {
	id: string;
	org_id: string;
	service_account_id: string;
	issuer: string;
	audiences: string;
	subject_pattern: string;
	claim_conditions_json: string;
	max_ttl_seconds: number;
	restriction_json: string;
}

interface Restriction {
	permissions?: string[];
	resources?: string[];
}

interface ParsedJwt {
	header: { alg?: string; kid?: string; typ?: string };
	claims: Record<string, unknown>;
	/** The signed `header.payload`, as bytes. */
	input: Uint8Array;
	signature: Uint8Array;
}

function decodePart<T>(part: string, what: string): T {
	try {
		return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
	} catch {
		throw new StsError('invalid_grant', `The subject token's ${what} is not valid JSON.`);
	}
}

function parseJwt(token: string): ParsedJwt {
	const parts = token.split('.');
	if (parts.length !== 3)
		throw new StsError('invalid_request', 'subject_token must be a signed JWT.');
	const [headerPart, bodyPart, signaturePart] = parts as [string, string, string];
	return {
		header: decodePart<{ alg?: string; kid?: string; typ?: string }>(headerPart, 'header'),
		claims: decodePart<Record<string, unknown>>(bodyPart, 'payload'),
		input: new TextEncoder().encode(`${headerPart}.${bodyPart}`),
		signature: new Uint8Array(Buffer.from(signaturePart, 'base64url')),
	};
}

function claimString(claims: Record<string, unknown>, name: string): string {
	const value = claims[name];
	return typeof value === 'string' ? value : '';
}

function claimAudiences(claims: Record<string, unknown>): string[] {
	const aud = claims.aud;
	if (typeof aud === 'string') return [aud];
	if (Array.isArray(aud)) return aud.filter((value): value is string => typeof value === 'string');
	return [];
}

/**
 * `refs/heads/*`-style glob, reused for subject patterns: `*` matches within one segment and `**`
 * matches across segments. A missing or `*` pattern matches every subject.
 */
export function subjectMatches(pattern: string | null | undefined, subject: string): boolean {
	if (!pattern || pattern === '*') return true;
	const regex = new RegExp(
		`^${pattern
			.split('**')
			.map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
			.join('.*')}$`,
	);
	return regex.test(subject);
}

/** A claim condition is a primitive, an array of allowed primitives, or a JSON value to match. */
function claimMatches(actual: unknown, expected: unknown): boolean {
	if (Array.isArray(expected)) return expected.some((value) => claimMatches(actual, value));
	if (Array.isArray(actual)) return actual.some((value) => claimMatches(value, expected));
	if (expected === null) return actual === null || actual === undefined;
	if (typeof expected === 'object') return JSON.stringify(actual) === JSON.stringify(expected);
	return actual === expected;
}

function trustMatches(trust: TrustRow, claims: Record<string, unknown>): boolean {
	const audiences = parseJson<unknown>(trust.audiences, []);
	if (!Array.isArray(audiences) || audiences.length === 0) return false;
	const tokenAudiences = claimAudiences(claims);
	if (!tokenAudiences.some((audience) => audiences.includes(audience))) return false;

	const subject = claimString(claims, 'sub');
	if (!subject || !subjectMatches(trust.subject_pattern, subject)) return false;

	const conditions = parseJson<unknown>(trust.claim_conditions_json, {});
	if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions)) return false;
	for (const [claim, expected] of Object.entries(conditions as Record<string, unknown>)) {
		if (!claimMatches(claims[claim], expected)) return false;
	}
	return true;
}

/** Prefer the most specific subject pattern when two trusts overlap. */
function specificity(trust: TrustRow): number {
	return trust.subject_pattern.replace(/\*/g, '').length;
}

async function verifyWithJwk(
	jwk: Record<string, unknown>,
	alg: string,
	input: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	if (alg !== 'RS256' && alg !== 'ES256') return false;
	const importAlgorithm =
		alg === 'RS256'
			? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
			: { name: 'ECDSA', namedCurve: 'P-256' };
	const verifyAlgorithm =
		alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' };
	const key = await crypto.subtle.importKey('jwk', jwk as never, importAlgorithm as never, false, ['verify']);
	return crypto.subtle.verify(verifyAlgorithm as never, key, signature as never, input as never);
}

export class TokenService {
	readonly #sqlite: Database;
	/** Overridable in tests: the transport used to fetch an external issuer's JWKS. */
	fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = (input, init) =>
		fetch(input, init);
	#legacyOidc: PipelineOidc | null = null;

	constructor(private readonly ctx: CoreContext) {
		this.#sqlite = ctx.sqlite;
	}

	/** The issuer the exchange's own tokens carry: the platform origin. */
	issuer(): string {
		return this.ctx.config.platformOrigin;
	}

	async exchange(input: TokenExchangeInput): Promise<TokenExchangeResult> {
		const subjectToken = input.subjectToken?.trim();
		if (!subjectToken) throw new StsError('invalid_request', 'subject_token is required.');
		const parsed = parseJwt(subjectToken);
		const issuer = claimString(parsed.claims, 'iss');
		if (!issuer) throw new StsError('invalid_grant', 'The subject token has no issuer.');

		const trusts = this.trusts(issuer, input.trustId);
		if (trusts.length === 0)
			throw new StsError('invalid_grant', 'No federation trust accepts this subject token issuer.');

		const claims = await this.verifySubject(subjectToken, parsed, issuer);
		this.assertFresh(claims);

		const matching = trusts
			.filter((trust) => trustMatches(trust, claims))
			.sort((a, b) => specificity(b) - specificity(a) || a.id.localeCompare(b.id));
		const trust = matching[0];
		if (!trust)
			throw new StsError('invalid_grant', 'The subject token does not match any federation trust.');

		const { permissions, resources } = this.narrow(trust, input.scope);
		const ttl = this.ttl(trust);
		const audience = input.audience?.trim() || this.ctx.config.platformOrigin;
		const scopeClaim = permissions.length > 0 ? permissions.join(' ') : undefined;
		const accessToken = await this.ctx.signingKeys.sign(
			'sts',
			{
				sub: trust.service_account_id,
				aud: audience,
				org_id: trust.org_id,
				trust_id: trust.id,
				...(scopeClaim ? { scope: scopeClaim } : {}),
				...(resources.length > 0 ? { resources } : {}),
				// RFC 8693 §4.1 `act`: the identity the token was exchanged from.
				act: { iss: issuer, sub: claimString(claims, 'sub') },
			},
			ttl,
		);

		this.ctx.audit.record({
			action: 'iam.token.exchange',
			resource: 'service_account',
			resourceId: trust.service_account_id,
			orgId: trust.org_id,
			args: {
				trustId: trust.id,
				issuer,
				subject: claimString(claims, 'sub'),
				audience,
				scope: scopeClaim ?? null,
				expiresIn: ttl,
			},
			result: 'ok',
		});

		return {
			access_token: accessToken,
			issued_token_type: ACCESS_TOKEN_TYPE,
			token_type: 'Bearer',
			expires_in: ttl,
		};
	}

	// ---------------------------------------------------------------- internals

	/** Enabled trusts for one issuer. A trust is enabled while its service account is not disabled. */
	private trusts(issuer: string, trustId?: string): TrustRow[] {
		const params: string[] = [issuer];
		let sql = `SELECT t.* FROM federation_trusts t
			JOIN service_accounts s ON s.id = t.service_account_id AND s.org_id = t.org_id
			WHERE t.issuer = ? AND s.disabled_at IS NULL`;
		if (trustId) {
			sql += ' AND t.id = ?';
			params.push(trustId);
		}
		return this.#sqlite.query<TrustRow, string[]>(sql).all(...params);
	}

	/** Verify the JWT against the issuer's keys. Skiff's own tokens use the ring. */
	private async verifySubject(
		token: string,
		parsed: ParsedJwt,
		issuer: string,
	): Promise<Record<string, unknown>> {
		if (issuer === this.ctx.config.platformOrigin) {
			// Skiff workload, STS or future ring-issued OIDC token. The ring verifies the signature,
			// issuer and expiry; the trust supplies the audience and subject policy.
			for (const purpose of ['sts', 'workload', 'oidc']) {
				try {
					const claims = await this.ctx.signingKeys.verify(purpose, token);
					return claims as unknown as Record<string, unknown>;
				} catch {
					// Try the next purpose; the kid only exists under one of them.
				}
			}
			throw new StsError('invalid_grant', 'The subject token is not a valid Skiff token.');
		}

		if (issuer === this.pipelineIssuer()) {
			// TODO(I4 follow-up): remove once pipeline OIDC signs with the `oidc` ring purpose.
			if (parsed.header.alg !== 'ES256')
				throw new StsError('invalid_grant', 'The pipeline OIDC token is not ES256.');
			const oidc = (this.#legacyOidc ??= new PipelineOidc(this.ctx));
			const key = oidc.jwks().keys.find((candidate) => candidate.kid === parsed.header.kid);
			if (!key || !(await verifyWithJwk(key, 'ES256', parsed.input, parsed.signature)))
				throw new StsError('invalid_grant', 'The pipeline OIDC token signature does not verify.');
			return parsed.claims;
		}

		const alg = parsed.header.alg ?? '';
		if (alg !== 'RS256' && alg !== 'ES256')
			throw new StsError('invalid_grant', `Unsupported subject token algorithm ${alg || 'none'}.`);
		const keys = await this.fetchJwks(issuer);
		const candidates = parsed.header.kid
			? keys.filter((key) => key.kid === parsed.header.kid)
			: keys;
		for (const key of candidates) {
			if (await verifyWithJwk(key, alg, parsed.input, parsed.signature).catch(() => false))
				return parsed.claims;
		}
		throw new StsError('invalid_grant', 'The subject token signature does not verify.');
	}

	private pipelineIssuer(): string {
		return `${this.ctx.config.platformOrigin}/api/pipeline/oidc`;
	}

	private assertFresh(claims: Record<string, unknown>): void {
		const now = Math.floor(this.ctx.now() / 1000);
		const exp = claims.exp;
		if (typeof exp !== 'number' || exp + SKEW_SECONDS < now)
			throw new StsError('invalid_grant', 'The subject token has expired.');
		const nbf = claims.nbf;
		if (typeof nbf === 'number' && nbf - SKEW_SECONDS > now)
			throw new StsError('invalid_grant', 'The subject token is not valid yet.');
	}

	private narrow(trust: TrustRow, requestedScope?: string): { permissions: string[]; resources: string[] } {
		const restriction = parseJson<Restriction>(trust.restriction_json, {});
		const ceiling = Array.isArray(restriction.permissions)
			? restriction.permissions.filter((permission): permission is string => isPermission(permission))
			: null;
		const resources = Array.isArray(restriction.resources)
			? restriction.resources.filter((resource): resource is string => typeof resource === 'string')
			: [];

		const requested = (requestedScope ?? '')
			.split(/\s+/)
			.map((scope) => scope.trim())
			.filter(Boolean);
		for (const permission of requested) {
			if (!isPermission(permission))
				throw new StsError('invalid_request', `"${permission}" is not a permission in the catalog.`);
		}

		if (ceiling === null) {
			// No permission ceiling on the trust: the service account's bindings are the ceiling,
			// and an explicit scope is the caller's own narrowing.
			return { permissions: requested, resources };
		}
		const outside = requested.find((permission) => !ceiling.includes(permission));
		if (outside)
			throw new StsError(
				'invalid_grant',
				`The requested scope "${outside}" exceeds the federation trust's restriction.`,
			);
		return { permissions: requested.length > 0 ? requested : ceiling, resources };
	}

	private ttl(trust: TrustRow): number {
		const configured = Number(trust.max_ttl_seconds);
		if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TTL_SECONDS;
		return Math.max(1, Math.min(Math.floor(configured), MAX_TTL_SECONDS));
	}

	/** Fetch an issuer's JWKS. External issuers use `/.well-known/jwks.json`; GitHub uses `.well-known/jwks`. */
	private async fetchJwks(issuer: string): Promise<Array<Record<string, unknown>>> {
		const base = issuer.replace(/\/+$/, '');
		const urls = base === GITHUB_OIDC_ISSUER
			? [`${base}/.well-known/jwks`]
			: [`${base}/.well-known/jwks.json`];
		for (const url of urls) {
			const keys = await this.tryJwks(url);
			if (keys) return keys;
		}
		// Some issuers only publish a discovery document; follow its `jwks_uri` once.
		const discovery = await this.tryJson(`${base}/.well-known/openid-configuration`);
		const jwksUri = discovery && typeof discovery.jwks_uri === 'string' ? discovery.jwks_uri : null;
		if (jwksUri) {
			const keys = await this.tryJwks(jwksUri);
			if (keys) return keys;
		}
		throw new StsError('invalid_grant', `Could not fetch signing keys for ${issuer}.`);
	}

	private async tryJwks(url: string): Promise<Array<Record<string, unknown>> | null> {
		const body = await this.tryJson(url);
		if (!body || !Array.isArray(body.keys)) return null;
		return body.keys.filter(
			(key): key is Record<string, unknown> => Boolean(key) && typeof key === 'object',
		);
	}

	private async tryJson(url: string): Promise<Record<string, unknown> | null> {
		try {
			const response = await this.fetchImpl(url, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
			});
			if (!response.ok) return null;
			const body = (await response.json()) as unknown;
			return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	}
}

import { createPublicKey, verify } from 'node:crypto';

type Jwk = { kid?: string; kty?: string; n?: string; e?: string; [key: string]: unknown };

/**
 * CI OIDC tokens for the registry realm: GitHub Actions (docs/REGISTRY.md G3) and GitLab CI
 * `id_tokens` (docs/FORGES.md §8, D178).
 *
 * A workflow with `permissions: id-token: write` asks GitHub for a token whose audience is the
 * registry host and uses it as the registry password. The realm checks the RS256 signature against
 * GitHub's published keys, the issuer, the audience and the time window, then matches the
 * `repository` and `ref` claims against the org's trusts. No secret is stored anywhere.
 */

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const JWKS_TTL_MS = 60 * 60_000;
/** Allowed clock skew between GitHub and this host. */
const SKEW_SECONDS = 60;

export interface GithubOidcClaims {
	iss: string;
	aud: string | string[];
	sub: string;
	repository: string;
	ref: string;
	exp: number;
	nbf?: number;
	iat?: number;
	repository_owner?: string;
	workflow?: string;
	actor?: string;
	run_id?: string;
}

export class OidcError extends Error {}

const keyCache = new Map<string, { at: number; keys: Jwk[] }>();

/** Tests reset the key cache between fake issuers. */
export function resetOidcKeyCache(): void {
	keyCache.clear();
}

async function fetchKeys(jwksUrl: string, fetchImpl: typeof fetch, now: number, refresh = false): Promise<Jwk[]> {
	const cached = keyCache.get(jwksUrl);
	if (cached && !refresh && now - cached.at < JWKS_TTL_MS) return cached.keys;
	const response = await fetchImpl(jwksUrl, { signal: AbortSignal.timeout(10_000) });
	if (!response.ok) throw new OidcError(`The issuer's signing keys answered ${response.status}`);
	const body = (await response.json()) as { keys?: Jwk[] };
	const keys = Array.isArray(body.keys) ? body.keys : [];
	keyCache.set(jwksUrl, { at: now, keys });
	return keys;
}

function decodePart<T>(part: string | undefined, what: string): T {
	try {
		return JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as T;
	} catch {
		throw new OidcError(`The token's ${what} is not valid JSON`);
	}
}

/** The claims of a JWT without checking anything (to choose the issuer's keys). */
export function unverifiedClaims(token: string): Record<string, unknown> {
	const parts = token.split('.');
	if (parts.length !== 3) throw new OidcError('Not a JWT');
	return decodePart<Record<string, unknown>>(parts[1], 'payload');
}

/**
 * Verify an RS256 JWT from `issuer` against the keys at `jwksUrl`: signature (refreshing the keys
 * once for an unknown `kid`), issuer, audience and time window. Returns the claims or throws.
 */
export async function verifyRs256Jwt<T extends { iss: string; aud: string | string[]; exp: number; nbf?: number }>(
	token: string,
	options: { issuer: string; jwksUrl: string; audience: string; fetch?: typeof fetch; now?: number; issuerName: string },
): Promise<T> {
	const parts = token.split('.');
	if (parts.length !== 3) throw new OidcError('Not a JWT');
	const header = decodePart<{ alg?: string; kid?: string }>(parts[0], 'header');
	if (header.alg !== 'RS256') throw new OidcError(`Unsupported token algorithm ${header.alg ?? 'none'}`);
	const now = options.now ?? Date.now();
	const fetchImpl = options.fetch ?? fetch;
	let jwk = (await fetchKeys(options.jwksUrl, fetchImpl, now)).find((key) => key.kid === header.kid);
	// Issuers rotate keys; a kid we have not seen means the cache is stale.
	if (!jwk) jwk = (await fetchKeys(options.jwksUrl, fetchImpl, now, true)).find((key) => key.kid === header.kid);
	if (!jwk) throw new OidcError('The token is signed with an unknown key');
	const ok = verify(
		'RSA-SHA256',
		Buffer.from(`${parts[0]}.${parts[1]}`),
		createPublicKey({ key: jwk, format: 'jwk' } as never),
		Buffer.from(parts[2]!, 'base64url'),
	);
	if (!ok) throw new OidcError('The token signature does not verify');
	const claims = decodePart<T>(parts[1], 'payload');
	if (claims.iss !== options.issuer) throw new OidcError(`The token was not issued by ${options.issuerName}`);
	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!audiences.includes(options.audience))
		throw new OidcError(`The token's audience must be ${options.audience} (request it with &audience=${options.audience})`);
	const seconds = Math.floor(now / 1000);
	if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < seconds) throw new OidcError('The token has expired');
	if (typeof claims.nbf === 'number' && claims.nbf - SKEW_SECONDS > seconds) throw new OidcError('The token is not valid yet');
	return claims;
}

/** Verify a GitHub Actions OIDC token for `audience`; returns its claims or throws OidcError. */
export async function verifyGithubOidc(
	token: string,
	options: { audience: string; fetch?: typeof fetch; now?: number },
): Promise<GithubOidcClaims> {
	const claims = await verifyRs256Jwt<GithubOidcClaims>(token, {
		...options,
		issuer: GITHUB_OIDC_ISSUER,
		jwksUrl: JWKS_URL,
		issuerName: 'GitHub Actions',
	});
	if (typeof claims.repository !== 'string' || typeof claims.ref !== 'string') throw new OidcError('The token has no repository or ref claim');
	return claims;
}

/** GitLab CI `id_tokens` claims the registry reads (D178). */
export interface GitlabOidcClaims {
	iss: string;
	aud: string | string[];
	sub: string;
	exp: number;
	nbf?: number;
	project_path: string;
	ref: string;
	ref_type: 'branch' | 'tag' | string;
	namespace_path?: string;
	pipeline_id?: string;
	user_login?: string;
}

/**
 * Verify a GitLab CI ID token for `audience`, issued by one of `issuers` (the GitLab base URLs the
 * org's trusts name). GitLab publishes its keys at `<issuer>/oauth/discovery/keys`. Adds
 * `fullRef` (`refs/heads/<ref>` or `refs/tags/<ref>`) for ref globs.
 */
export async function verifyGitlabOidc(
	token: string,
	options: { audience: string; issuers: string[]; fetch?: typeof fetch; now?: number },
): Promise<GitlabOidcClaims & { fullRef: string }> {
	const iss = unverifiedClaims(token).iss;
	if (typeof iss !== 'string' || !options.issuers.includes(iss))
		throw new OidcError('No organisation trusts ID tokens from this GitLab instance');
	const claims = await verifyRs256Jwt<GitlabOidcClaims>(token, {
		audience: options.audience,
		fetch: options.fetch,
		now: options.now,
		issuer: iss,
		jwksUrl: `${iss}/oauth/discovery/keys`,
		issuerName: iss,
	});
	if (typeof claims.project_path !== 'string' || typeof claims.ref !== 'string') throw new OidcError('The token has no project_path or ref claim');
	return { ...claims, fullRef: claims.ref_type === 'tag' ? `refs/tags/${claims.ref}` : `refs/heads/${claims.ref}` };
}

/** `refs/heads/*`-style glob: `*` matches within a segment, `**` across segments. */
export function refMatches(pattern: string | null, ref: string): boolean {
	if (!pattern) return true;
	const regex = new RegExp(
		`^${pattern
			.split('**')
			.map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
			.join('.*')}$`,
	);
	return regex.test(ref);
}

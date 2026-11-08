import { createPublicKey, verify } from 'node:crypto';

type Jwk = { kid?: string; kty?: string; n?: string; e?: string; [key: string]: unknown };

/**
 * GitHub Actions OIDC tokens for the registry realm (docs/REGISTRY.md G3).
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

let cache: { at: number; keys: Jwk[] } | null = null;

/** Tests reset the key cache between fake issuers. */
export function resetOidcKeyCache(): void {
	cache = null;
}

async function keys(fetchImpl: typeof fetch, now: number, refresh = false): Promise<Jwk[]> {
	if (cache && !refresh && now - cache.at < JWKS_TTL_MS) return cache.keys;
	const response = await fetchImpl(JWKS_URL, { signal: AbortSignal.timeout(10_000) });
	if (!response.ok) throw new OidcError(`GitHub's signing keys answered ${response.status}`);
	const body = (await response.json()) as { keys?: Jwk[] };
	cache = { at: now, keys: Array.isArray(body.keys) ? body.keys : [] };
	return cache.keys;
}

function decodePart<T>(part: string | undefined, what: string): T {
	try {
		return JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as T;
	} catch {
		throw new OidcError(`The token's ${what} is not valid JSON`);
	}
}

/** Verify a GitHub Actions OIDC token for `audience`; returns its claims or throws OidcError. */
export async function verifyGithubOidc(
	token: string,
	options: { audience: string; fetch?: typeof fetch; now?: number },
): Promise<GithubOidcClaims> {
	const parts = token.split('.');
	if (parts.length !== 3) throw new OidcError('Not a JWT');
	const header = decodePart<{ alg?: string; kid?: string }>(parts[0], 'header');
	if (header.alg !== 'RS256') throw new OidcError(`Unsupported token algorithm ${header.alg ?? 'none'}`);
	const now = options.now ?? Date.now();
	const fetchImpl = options.fetch ?? fetch;
	let jwk = (await keys(fetchImpl, now)).find((key) => key.kid === header.kid);
	// GitHub rotates keys; a kid we have not seen means the cache is stale.
	if (!jwk) jwk = (await keys(fetchImpl, now, true)).find((key) => key.kid === header.kid);
	if (!jwk) throw new OidcError('The token is signed with an unknown key');
	const ok = verify(
		'RSA-SHA256',
		Buffer.from(`${parts[0]}.${parts[1]}`),
		createPublicKey({ key: jwk, format: 'jwk' } as never),
		Buffer.from(parts[2]!, 'base64url'),
	);
	if (!ok) throw new OidcError('The token signature does not verify');
	const claims = decodePart<GithubOidcClaims>(parts[1], 'payload');
	if (claims.iss !== GITHUB_OIDC_ISSUER) throw new OidcError('The token was not issued by GitHub Actions');
	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!audiences.includes(options.audience))
		throw new OidcError(`The token's audience must be ${options.audience} (request it with &audience=${options.audience})`);
	const seconds = Math.floor(now / 1000);
	if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < seconds) throw new OidcError('The token has expired');
	if (typeof claims.nbf === 'number' && claims.nbf - SKEW_SECONDS > seconds) throw new OidcError('The token is not valid yet');
	if (typeof claims.repository !== 'string' || typeof claims.ref !== 'string') throw new OidcError('The token has no repository or ref claim');
	return claims;
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

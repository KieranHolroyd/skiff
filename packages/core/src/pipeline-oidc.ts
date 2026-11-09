import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';

type JsonWebKey = Record<string, unknown>;
import { eq } from 'drizzle-orm';
import { settings } from '@skiff/db';
import type { CoreContext } from './context.ts';
import { decrypt } from './util.ts';

/**
 * OIDC ID tokens for pipeline jobs (docs/PIPELINES.md W9): `POST /api/pipeline/oidc-token` gives a
 * running, trusted job a short-lived ES256 JWT that a cloud (AWS, GCP, Azure, Vault, …) can trust
 * by pointing a federated identity at Skiff's issuer. Discovery and keys are public at
 * `<issuer>/.well-known/openid-configuration` and `<issuer>/jwks`.
 *
 * Tokens are signed by the ring's `oidc` purpose (I15), but keep the path-based issuer so clouds
 * already configured against it keep working (D162). The old settings key stays published in the
 * JWKS during the overlap; it is never used to sign again and is only read here.
 *
 * The `sub` claim follows GitHub's shape so existing trust policies translate directly:
 * `repo:<org>/<repository>:environment:<env>`, `…:pull_request`, or `…:ref:<ref>`.
 */

/** Legacy (D162) key, sealed directly with the master key. Read-only until the overlap ends. */
const SETTING_KEY = 'pipelines.oidc.signing_key';
const TOKEN_TTL_SECONDS = 10 * 60;

interface StoredKey {
	kid: string;
	nonce: string;
	ciphertext: string;
	createdAt: number;
}

export interface PipelineOidcClaims {
	org: string;
	repository: string;
	repositoryId: string;
	ref: string;
	sha: string;
	workflow: string;
	workflowPath: string;
	job: string;
	runId: string;
	runNumber: number;
	runAttempt: number;
	event: string;
	actor: string | null;
	environment: string | null;
	trust: string;
}

export class PipelineOidc {
	constructor(private readonly ctx: CoreContext) {}

	issuer(): string {
		return `${this.ctx.config.platformOrigin}/api/pipeline/oidc`;
	}

	/**
	 * The pre-ring (D162) key, read-only. It is no longer created or used to sign; it stays
	 * published so tokens minted before the move keep verifying and clouds that already trust it
	 * survive the overlap. Remove once the last old token TTL has passed.
	 */
	private legacyKey(): { kid: string; publicJwk: JsonWebKey } | null {
		const row = this.ctx.db.select().from(settings).where(eq(settings.key, SETTING_KEY)).get();
		if (!row) return null;
		try {
			const stored = JSON.parse(row.value) as StoredKey;
			const pem = new TextDecoder().decode(decrypt(this.ctx.config.masterKey, stored.ciphertext, stored.nonce));
			const publicJwk = createPublicKey(createPrivateKey(pem)).export({ format: 'jwk' }) as JsonWebKey;
			return { kid: stored.kid, publicJwk };
		} catch {
			return null;
		}
	}

	/** The ring's `oidc` keys plus the legacy key while old tokens may still be in flight. */
	jwks(): { keys: JsonWebKey[] } {
		const keys: JsonWebKey[] = this.ctx.signingKeys.jwks('oidc');
		const legacy = this.legacyKey();
		if (legacy && !keys.some((key) => key.kid === legacy.kid)) {
			keys.push({ ...legacy.publicJwk, kid: legacy.kid, alg: 'ES256', use: 'sig' });
		}
		return { keys };
	}

	discovery(): Record<string, unknown> {
		const issuer = this.issuer();
		return {
			issuer,
			jwks_uri: `${issuer}/jwks`,
			response_types_supported: ['id_token'],
			subject_types_supported: ['public'],
			id_token_signing_alg_values_supported: ['ES256'],
			scopes_supported: ['openid'],
			claims_supported: [
				'sub', 'aud', 'exp', 'iat', 'iss', 'jti', 'nbf', 'repository', 'repository_id', 'repository_owner', 'ref',
				'ref_type', 'sha', 'workflow', 'workflow_ref', 'job_workflow_ref', 'job', 'run_id', 'run_number', 'run_attempt',
				'event_name', 'actor', 'environment', 'trust',
			],
		};
	}

	/** `sub` in GitHub's shape: environment first, then pull request, then the ref. */
	static subject(claims: PipelineOidcClaims): string {
		const base = `repo:${claims.org}/${claims.repository}`;
		if (claims.environment) return `${base}:environment:${claims.environment}`;
		if (claims.event === 'pull_request') return `${base}:pull_request`;
		return `${base}:ref:${claims.ref}`;
	}

	mint(claims: PipelineOidcClaims, audience: string | undefined): { token: string; expiresAt: number } {
		const now = Math.floor(this.ctx.now() / 1000);
		const exp = now + TOKEN_TTL_SECONDS;
		const payload = {
			aud: audience ?? this.ctx.config.platformOrigin,
			sub: PipelineOidc.subject(claims),
			nbf: now - 5,
			jti: randomUUID(),
			repository: `${claims.org}/${claims.repository}`,
			repository_id: claims.repositoryId,
			repository_owner: claims.org,
			ref: claims.ref,
			ref_type: claims.ref.startsWith('refs/tags/') ? 'tag' : 'branch',
			sha: claims.sha,
			workflow: claims.workflow,
			workflow_ref: `${claims.org}/${claims.repository}/${claims.workflowPath}@${claims.ref}`,
			job_workflow_ref: `${claims.org}/${claims.repository}/${claims.workflowPath}@${claims.ref}`,
			job: claims.job,
			run_id: claims.runId,
			run_number: String(claims.runNumber),
			run_attempt: String(claims.runAttempt),
			event_name: claims.event,
			actor: claims.actor ?? '',
			...(claims.environment ? { environment: claims.environment } : {}),
			trust: claims.trust,
		};
		// Signed by the ring's `oidc` purpose, but keeps the path-based issuer (D162) as an alias.
		const token = this.ctx.signingKeys.signSync('oidc', payload, TOKEN_TTL_SECONDS, { issuer: this.issuer() });
		return { token, expiresAt: exp * 1000 };
	}
}

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';

type JsonWebKey = Record<string, unknown>;
import { eq } from 'drizzle-orm';
import { settings } from '@skiff/db';
import type { CoreContext } from './context.ts';
import { decrypt, encrypt } from './util.ts';

/**
 * OIDC ID tokens for pipeline jobs (docs/PIPELINES.md W9): `POST /api/pipeline/oidc-token` gives a
 * running, trusted job a short-lived ES256 JWT that a cloud (AWS, GCP, Azure, Vault, …) can trust
 * by pointing a federated identity at Skiff's issuer. Discovery and keys are public at
 * `<issuer>/.well-known/openid-configuration` and `<issuer>/jwks`.
 *
 * This is deliberately separate from registry auth: the registry realm signs its own ES256 tokens
 * against an X.509 certificate zot trusts (docs/REGISTRY.md §4.1).
 *
 * The `sub` claim follows GitHub's shape so existing trust policies translate directly:
 * `repo:<org>/<repository>:environment:<env>`, `…:pull_request`, or `…:ref:<ref>`.
 */

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

function base64url(input: Buffer | string): string {
	return Buffer.from(input).toString('base64url');
}

export class PipelineOidc {
	private cached: { kid: string; privateKey: ReturnType<typeof createPrivateKey>; publicJwk: JsonWebKey } | null = null;

	constructor(private readonly ctx: CoreContext) {}

	issuer(): string {
		return `${this.ctx.config.platformOrigin}/api/pipeline/oidc`;
	}

	/** Load the signing key, creating it on first use (sealed with the master key in settings). */
	private key() {
		if (this.cached) return this.cached;
		const row = this.ctx.db.select().from(settings).where(eq(settings.key, SETTING_KEY)).get();
		let stored: StoredKey | null = null;
		try {
			stored = row ? (JSON.parse(row.value) as StoredKey) : null;
		} catch {
			stored = null;
		}
		if (!stored) {
			const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
			const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
			const sealed = encrypt(this.ctx.config.masterKey, new TextEncoder().encode(pem));
			stored = { kid: randomUUID(), nonce: sealed.nonce, ciphertext: sealed.ciphertext, createdAt: this.ctx.now() };
			this.ctx.db
				.insert(settings)
				.values({ key: SETTING_KEY, value: JSON.stringify(stored), updatedAt: this.ctx.now() })
				.onConflictDoNothing()
				.run();
			// Another process may have won the insert; always use what is stored.
			const again = this.ctx.db.select().from(settings).where(eq(settings.key, SETTING_KEY)).get();
			if (again) stored = JSON.parse(again.value) as StoredKey;
		}
		const pem = new TextDecoder().decode(decrypt(this.ctx.config.masterKey, stored.ciphertext, stored.nonce));
		const privateKey = createPrivateKey(pem);
		const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' }) as JsonWebKey;
		this.cached = { kid: stored.kid, privateKey, publicJwk };
		return this.cached;
	}

	jwks(): { keys: JsonWebKey[] } {
		const { kid, publicJwk } = this.key();
		return { keys: [{ ...publicJwk, kid, alg: 'ES256', use: 'sig' }] };
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
		const { kid, privateKey } = this.key();
		const now = Math.floor(this.ctx.now() / 1000);
		const exp = now + TOKEN_TTL_SECONDS;
		const payload = {
			iss: this.issuer(),
			aud: audience ?? this.ctx.config.platformOrigin,
			sub: PipelineOidc.subject(claims),
			iat: now,
			nbf: now - 5,
			exp,
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
		const header = base64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
		const body = base64url(JSON.stringify(payload));
		const signature = sign('sha256', Buffer.from(`${header}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
		return { token: `${header}.${body}.${base64url(signature)}`, expiresAt: exp * 1000 };
	}
}

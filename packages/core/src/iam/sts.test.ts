import { beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { ACCESS_TOKEN_TYPE, StsError } from './sts.ts';
import { createCore, type Core } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';

/**
 * RFC 8693 token exchange (docs/IAM.md I16–I17). The migrations are applied by the real migrator
 * in production; this test applies the same DDL for the two new tables because
 * `packages/db/src/migrations.ts` is generated at build time and is not regenerated here.
 */
const dir = mkdtempSync(join(tmpdir(), 'skiff-sts-'));
const opened = createDb({ path: ':memory:' });
opened.sqlite.exec(`
	CREATE TABLE IF NOT EXISTS signing_keys (
		kid TEXT PRIMARY KEY,
		alg TEXT NOT NULL DEFAULT 'ES256',
		purpose TEXT NOT NULL,
		public_jwk TEXT NOT NULL,
		private_sealed TEXT NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('next','active','retired')),
		created_at INTEGER NOT NULL,
		activated_at INTEGER,
		retire_after INTEGER
	);
	CREATE INDEX IF NOT EXISTS signing_keys_purpose_state_idx ON signing_keys (purpose, state);

	CREATE TABLE IF NOT EXISTS federation_trusts (
		id TEXT PRIMARY KEY,
		org_id TEXT NOT NULL,
		service_account_id TEXT NOT NULL,
		issuer TEXT NOT NULL,
		audiences TEXT NOT NULL DEFAULT '[]',
		subject_pattern TEXT NOT NULL DEFAULT '*',
		claim_conditions_json TEXT NOT NULL DEFAULT '{}',
		max_ttl_seconds INTEGER NOT NULL DEFAULT 900,
		restriction_json TEXT NOT NULL DEFAULT '{}'
	);
	CREATE INDEX IF NOT EXISTS federation_trusts_org_idx ON federation_trusts (org_id);
	CREATE INDEX IF NOT EXISTS federation_trusts_issuer_idx ON federation_trusts (issuer);
`);

const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const NOW = Date.parse('2026-11-08T12:00:00Z');
const nowSeconds = (offset = 0) => Math.floor(NOW / 1000) + offset;

let now = NOW;
let core: Core;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = {
	...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
	kid: 'gh-1',
	alg: 'RS256',
	use: 'sig',
};

function open(): Core {
	return createCore({
		db: opened.db,
		sqlite: opened.sqlite,
		version: '0.1.0',
		config: {
			dataDir: dir,
			platformOrigin: 'https://control.test',
			contentDomain: 'sites.test',
			objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
			masterKey: new Uint8Array(32).fill(7),
			siteCookieSecret: 'site-cookie-secret-123',
			objectStoreSecret: 'object-secret-123',
			desiredAgentVersion: '0.1.0',
			now: () => now,
		},
	});
}

function githubToken(
	overrides: Record<string, unknown> = {},
	options: { kid?: string; signingKey?: typeof privateKey } = {},
): string {
	const header = Buffer.from(
		JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: options.kid ?? 'gh-1' }),
	).toString('base64url');
	const payload = Buffer.from(
		JSON.stringify({
			iss: GITHUB_ISSUER,
			aud: 'https://control.test',
			sub: 'repo:acme/web:ref:refs/heads/main',
			ref: 'refs/heads/main',
			repository: 'acme/web',
			exp: nowSeconds(300),
			iat: nowSeconds(-10),
			...overrides,
		}),
	).toString('base64url');
	const signature = nodeSign('RSA-SHA256', Buffer.from(`${header}.${payload}`), options.signingKey ?? privateKey);
	return `${header}.${payload}.${signature.toString('base64url')}`;
}

function insertTrust(
	overrides: Partial<{
		id: string;
		orgId: string;
		serviceAccountId: string;
		issuer: string;
		audiences: string[];
		subjectPattern: string;
		conditions: Record<string, unknown>;
		maxTtl: number;
		restriction: Record<string, unknown>;
	}> = {},
): string {
	const trust = {
		id: overrides.id ?? 'ft_1',
		orgId: overrides.orgId ?? 'org_1',
		serviceAccountId: overrides.serviceAccountId ?? 'sa_deployer',
		issuer: overrides.issuer ?? GITHUB_ISSUER,
		audiences: overrides.audiences ?? ['https://control.test'],
		subjectPattern: overrides.subjectPattern ?? 'repo:acme/web:ref:refs/heads/main',
		conditions: overrides.conditions ?? { ref: 'refs/heads/main' },
		maxTtl: overrides.maxTtl ?? 900,
		restriction: overrides.restriction ?? {
			permissions: ['project:read', 'deployment:create'],
			resources: ['project:web'],
		},
	};
	opened.sqlite.run(
		`INSERT INTO federation_trusts
		   (id, org_id, service_account_id, issuer, audiences, subject_pattern, claim_conditions_json,
		    max_ttl_seconds, restriction_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			trust.id,
			trust.orgId,
			trust.serviceAccountId,
			trust.issuer,
			JSON.stringify(trust.audiences),
			trust.subjectPattern,
			JSON.stringify(trust.conditions),
			trust.maxTtl,
			JSON.stringify(trust.restriction),
		],
	);
	return trust.id;
}

beforeEach(() => {
	now = NOW;
	opened.sqlite.exec(`
		DELETE FROM federation_trusts;
		DELETE FROM signing_keys;
		DELETE FROM service_accounts;
		INSERT INTO service_accounts
		  (id, org_id, name, description, owner_group_id, disabled_at, created_by, created_at)
		VALUES ('sa_deployer', 'org_1', 'deployer', '', NULL, NULL, 'user_1', ${NOW});
	`);
	core = open();
	// A static JWKS keeps the external issuer path deterministic.
	core.ctx.sts.fetchImpl = async (input) => {
		const url = String(input);
		expect(url).toBe(`${GITHUB_ISSUER}/.well-known/jwks`);
		return new Response(JSON.stringify({ keys: [publicJwk] }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};
});

describe('token exchange', () => {
	test('a matching GitHub Actions token becomes a ≤1h service-account token', async () => {
		insertTrust();
		const result = await core.ctx.sts.exchange({ subjectToken: githubToken() });
		expect(result).toMatchObject({
			token_type: 'Bearer',
			issued_token_type: ACCESS_TOKEN_TYPE,
			expires_in: 900,
		});

		const claims = await core.ctx.signingKeys.verify('sts', result.access_token, {
			audience: 'https://control.test',
		});
		expect(claims).toMatchObject({
			iss: 'https://control.test',
			sub: 'sa_deployer',
			aud: 'https://control.test',
			org_id: 'org_1',
			trust_id: 'ft_1',
			scope: 'project:read deployment:create',
			resources: ['project:web'],
			act: { iss: GITHUB_ISSUER, sub: 'repo:acme/web:ref:refs/heads/main' },
		});
	});

	test('honours the requested audience and narrows the scope without widening it', async () => {
		insertTrust();
		const token = githubToken();

		const narrow = await core.ctx.sts.exchange({
			subjectToken: token,
			audience: 'https://api.test',
			scope: 'project:read',
		});
		const claims = await core.ctx.signingKeys.verify('sts', narrow.access_token, {
			audience: 'https://api.test',
		});
		expect(claims).toMatchObject({ aud: 'https://api.test', scope: 'project:read' });
		expect(claims.resources).toEqual(['project:web']);

		const outside = await core.ctx.sts.exchange({ subjectToken: token, scope: 'org:delete' }).catch(
			(error: unknown) => error,
		);
		expect(outside).toBeInstanceOf(StsError);
		expect((outside as StsError).code).toBe('invalid_grant');
	});

	test('applies the trust TTL cap of one hour', async () => {
		insertTrust({ maxTtl: 24 * 60 * 60 });
		const result = await core.ctx.sts.exchange({ subjectToken: githubToken() });
		expect(result.expires_in).toBe(3600);
	});

	test('rejects an expired subject token', async () => {
		insertTrust();
		const error = await core.ctx.sts
			.exchange({ subjectToken: githubToken({ exp: nowSeconds(-120) }) })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(StsError);
		expect((error as StsError).code).toBe('invalid_grant');
	});

	test('rejects a subject that does not match the subject pattern or claim conditions', async () => {
		insertTrust();
		const wrongSubject = await core.ctx.sts
			.exchange({ subjectToken: githubToken({ sub: 'repo:someone-else/web:ref:refs/heads/main' }) })
			.catch((caught: unknown) => caught);
		expect(wrongSubject).toBeInstanceOf(StsError);
		expect((wrongSubject as StsError).code).toBe('invalid_grant');

		const wrongCondition = await core.ctx.sts
			.exchange({ subjectToken: githubToken({ ref: 'refs/heads/feature' }) })
			.catch((caught: unknown) => caught);
		expect(wrongCondition).toBeInstanceOf(StsError);
		expect((wrongCondition as StsError).code).toBe('invalid_grant');
	});

	test('rejects an audience the trust does not list', async () => {
		insertTrust({ audiences: ['https://registry.test'] });
		const error = await core.ctx.sts
			.exchange({ subjectToken: githubToken() })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(StsError);
		expect((error as StsError).code).toBe('invalid_grant');
	});

	test('rejects a disabled service account even when the trust matches', async () => {
		insertTrust();
		opened.sqlite.run('UPDATE service_accounts SET disabled_at = ? WHERE id = ?', [NOW, 'sa_deployer']);
		const error = await core.ctx.sts
			.exchange({ subjectToken: githubToken() })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(StsError);
		expect((error as StsError).code).toBe('invalid_grant');
	});

	test('trust_id restricts matching to that one trust', async () => {
		insertTrust();
		insertTrust({ id: 'ft_2', restriction: { permissions: ['project:read'] } });
		const result = await core.ctx.sts.exchange({
			subjectToken: githubToken(),
			trustId: 'ft_2',
			scope: 'project:read',
		});
		const claims = await core.ctx.signingKeys.verify('sts', result.access_token);
		expect(claims.trust_id).toBe('ft_2');

		const missing = await core.ctx.sts
			.exchange({ subjectToken: githubToken(), trustId: 'ft_missing' })
			.catch((caught: unknown) => caught);
		expect(missing).toBeInstanceOf(StsError);
		expect((missing as StsError).code).toBe('invalid_grant');
	});

	test('accepts a Skiff-issued token through the ring, not an external JWKS', async () => {
		insertTrust({
			id: 'ft_skiff',
			issuer: 'https://control.test',
			audiences: ['https://control.test'],
			subjectPattern: 'sa_previous',
			conditions: {},
			restriction: { permissions: ['project:read'] },
		});
		const subject = await core.ctx.signingKeys.sign(
			'sts',
			{ sub: 'sa_previous', aud: 'https://control.test' },
			300,
		);
		const result = await core.ctx.sts.exchange({ subjectToken: subject });
		const claims = await core.ctx.signingKeys.verify('sts', result.access_token);
		expect(claims).toMatchObject({
			sub: 'sa_deployer',
			trust_id: 'ft_skiff',
			scope: 'project:read',
			act: { iss: 'https://control.test', sub: 'sa_previous' },
		});
	});

	test('rejects a token with an unknown issuer before any network call', async () => {
		insertTrust();
		core.ctx.sts.fetchImpl = async () => {
			throw new Error('should not fetch');
		};
		const error = await core.ctx.sts
			.exchange({ subjectToken: githubToken({ iss: 'https://evil.test' }) })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(StsError);
		expect((error as StsError).code).toBe('invalid_grant');
	});
});

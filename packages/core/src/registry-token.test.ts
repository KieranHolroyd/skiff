import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { X509Certificate, verify as verifySignature } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDb, settings } from '@yoal/db';
import { DEFAULT_FEATURES } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { generateRegistrySigningKey, signRegistryToken } from './registry-token.ts';
import type { Core } from './index.ts';

const HOST = 'registry.sites.test';
const LEGACY = generateRegistrySigningKey('yoal-registry-token-legacy', Date.now());

const dir = mkdtempSync(join(tmpdir(), 'yoal-registry-token-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		features: DEFAULT_FEATURES,
		registryFetch: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
	},
});

const admin = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_a', role: 'owner', platformAdmin: true });
let workerId = '';

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
	opened.sqlite.run('CREATE TABLE IF NOT EXISTS organization (id TEXT PRIMARY KEY, name TEXT, slug TEXT, createdAt TEXT)');
	opened.sqlite.run(`INSERT INTO organization (id, name, slug) VALUES ('org_a', 'Acme', 'acme')`);
	workerId = core.nodes.join({ token: core.nodes.createJoinToken(admin, 'edge').token, name: 'homelab' }).nodeId;
	core.registry.update(admin, { enabled: true, node: 'homelab' });
});

function decode(token: string): {
	header: { alg: string; kid: string };
	claims: {
		aud: string;
		sub: string;
		iat: number;
		nbf: number;
		exp: number;
		access: Array<{ type: string; name: string; actions: string[] }>;
	};
} {
	const [header, body] = token.split('.');
	return {
		header: JSON.parse(Buffer.from(header!, 'base64url').toString()),
		claims: JSON.parse(Buffer.from(body!, 'base64url').toString()),
	};
}

function publicJwk(certificate: X509Certificate): Record<string, unknown> {
	const jwk = certificate.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
	return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

function verifiesWithCertificate(token: string, certificatePem: string): boolean {
	const [header, body, signature] = token.split('.');
	return verifySignature(
		'sha256',
		Buffer.from(`${header}.${body}`),
		{ key: new X509Certificate(certificatePem).publicKey, dsaEncoding: 'ieee-p1363' },
		Buffer.from(signature!, 'base64url'),
	);
}

describe('registry tokens on the signing-key ring', () => {
	test('the realm signs with the registry purpose and publishes that kid at the platform JWKS', async () => {
		const active = await core.ctx.signingKeys.active('registry');
		const issued = core.registry.issueToken({ kind: 'principal', principal: admin }, HOST, ['repository:acme/shop:pull']);
		const { header, claims } = decode(issued.token);

		expect(header).toMatchObject({ alg: 'ES256', kid: active.kid });
		expect(claims).toMatchObject({ aud: HOST, sub: 'user:user_1' });
		expect(claims.exp - claims.iat).toBe(300);
		expect(claims.nbf).toBeLessThanOrEqual(claims.iat);
		expect(claims.access).toEqual([{ type: 'repository', name: 'acme/shop', actions: ['pull'] }]);

		const verified = await core.ctx.signingKeys.verify('registry', issued.token, { audience: HOST });
		expect(verified).toMatchObject({ sub: 'user:user_1', aud: HOST });
		expect(core.ctx.signingKeys.jwks('registry').map((key) => key.kid)).toContain(active.kid);
		expect(core.ctx.signingKeys.jwksAll().keys.map((key) => key.kid)).toContain(active.kid);
	});

	test("zot's certificate is derived from the active ring key and follows a rotation", async () => {
		const [desired] = core.registry.desiredForNode(workerId);
		const first = core.workloads.activation(workerId, desired!.id);
		const firstCertPem = first.env.YOAL_REGISTRY_TOKEN_CERT!;
		const firstCert = new X509Certificate(firstCertPem);
		const firstKey = await core.ctx.signingKeys.active('registry');

		expect(firstCert.subject).toBe('CN=yoal-registry-token');
		expect(publicJwk(firstCert)).toEqual({
			kty: 'EC',
			crv: 'P-256',
			x: firstKey.publicJwk.x,
			y: firstKey.publicJwk.y,
		});
		const firstToken = core.registry.issueToken({ kind: 'principal', principal: admin }, HOST, ['repository:acme/shop:pull']);
		expect(verifiesWithCertificate(firstToken.token, firstCertPem)).toBe(true);
		// The certificate is cached by kid: rendering desired state again is byte-identical.
		expect(core.registry.desiredForNode(workerId)[0]!.activationVersion).toBe(desired!.activationVersion);

		// First rotation only publishes `next`; the second promotes it and the active kid moves.
		await core.ctx.signingKeys.rotate('registry');
		await core.ctx.signingKeys.rotate('registry');
		const nextKey = await core.ctx.signingKeys.active('registry');
		expect(nextKey.kid).not.toBe(firstKey.kid);

		const [nextDesired] = core.registry.desiredForNode(workerId);
		const nextCertPem = core.workloads.activation(workerId, nextDesired!.id).env.YOAL_REGISTRY_TOKEN_CERT!;
		const nextCert = new X509Certificate(nextCertPem);
		expect(nextDesired!.activationVersion).not.toBe(desired!.activationVersion);
		expect(publicJwk(nextCert)).toEqual({
			kty: 'EC',
			crv: 'P-256',
			x: nextKey.publicJwk.x,
			y: nextKey.publicJwk.y,
		});

		const nextToken = core.registry.issueToken({ kind: 'principal', principal: admin }, HOST, ['repository:acme/shop:pull']);
		expect(verifiesWithCertificate(nextToken.token, nextCertPem)).toBe(true);
		// The old certificate no longer verifies new tokens; old tokens expire within 5 minutes.
		expect(verifiesWithCertificate(nextToken.token, firstCertPem)).toBe(false);
	});

	test('the legacy settings key stays readable and old tokens still verify against it', () => {
		const value = core.ctx.secrets.seal('platform', JSON.stringify(LEGACY));
		core.ctx.db
			.insert(settings)
			.values({ key: 'registry.signingKey', value, updatedAt: core.ctx.now() })
			.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: core.ctx.now() } })
			.run();

		// Issuing a ring token must not delete or rewrite the legacy row.
		core.registry.issueToken({ kind: 'principal', principal: admin }, HOST, ['repository:acme/shop:pull']);
		const row = core.ctx.db.select().from(settings).where(eq(settings.key, 'registry.signingKey')).get();
		expect(row).toBeDefined();
		const stored = JSON.parse(core.ctx.secrets.open('platform', row!.value)) as { certificatePem: string };
		expect(stored.certificatePem).toBe(LEGACY.certificatePem);

		// A token minted before the move still verifies against the certificate zot had.
		const old = signRegistryToken(LEGACY, {
			issuer: 'https://control.test',
			service: HOST,
			subject: 'user:user_1',
			access: [{ type: 'repository', name: 'acme/shop', actions: ['pull'] }],
		});
		expect(verifiesWithCertificate(old.token, stored.certificatePem)).toBe(true);
	});
});

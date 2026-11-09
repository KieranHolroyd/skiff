import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { X509Certificate, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { DEFAULT_FEATURES } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { serviceAccountPrincipalFromSkiffToken, verifySkiffToken } from './iam/token-consumers.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const DIGEST = `sha256:${'c'.repeat(64)}`;
const HOST = 'registry.sites.test';

/** A fake zot: manifests answer with DIGEST when the bearer token grants pull on the repository. */
const zotCalls: Array<{ url: string; method: string; authorization: string | null }> = [];
let lastCert = '';
function claims(authorization: string | null): { access?: Array<{ name: string; actions: string[] }> } | null {
	if (!authorization?.startsWith('Bearer ')) return null;
	const [h, p, s] = authorization.slice(7).split('.');
	const cert = new X509Certificate(lastCert);
	if (!verify('sha256', Buffer.from(`${h}.${p}`), { key: cert.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url')))
		return null;
	return JSON.parse(Buffer.from(p!, 'base64url').toString());
}
const registryFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
	const url = String(input instanceof Request ? input.url : input);
	const authorization = new Headers(init.headers).get('authorization');
	zotCalls.push({ url, method: init.method ?? 'GET', authorization });
	const match = /^https:\/\/registry\.sites\.test\/v2\/(.+)\/(manifests|tags)\/(.+)$/.exec(url);
	if (!match) return new Response(null, { status: 404 });
	const granted = claims(authorization)?.access?.find((entry) => entry.name === match[1]);
	if (!granted) return new Response(null, { status: 401 });
	if (match[2] === 'tags') return Response.json({ name: match[1], tags: ['2', '1', 'skiff-d-dep_x'] });
	if ((init.method ?? 'GET') === 'DELETE') return granted.actions.includes('delete') ? new Response(null, { status: 202 }) : new Response(null, { status: 401 });
	return new Response(null, { status: 200, headers: { 'Docker-Content-Digest': DIGEST } });
}) as typeof fetch;

const dir = mkdtempSync(join(tmpdir(), 'skiff-registry-'));
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
		registryFetch,
	},
});

const admin = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_a', role: 'owner', platformAdmin: true });
const adminKey = buildPrincipal({ kind: 'apiKey', userId: 'user_1', orgId: 'org_a', role: 'owner', platformAdmin: true, granted: ['image:push'] });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_a', role: 'viewer' });
const deployer = buildPrincipal({ kind: 'user', userId: 'user_3', orgId: 'org_a', role: 'deployer' });
const outsider = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_b', role: 'owner' });
let edgeId = '';
let workerId = '';

function decode(token: string) {
	return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as {
		aud: string;
		sub: string;
		exp: number;
		iat: number;
		access: Array<{ type: string; name: string; actions: string[] }>;
	};
}

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeAll(async () => {
	opened.sqlite.run('CREATE TABLE IF NOT EXISTS organization (id TEXT PRIMARY KEY, name TEXT, slug TEXT, createdAt TEXT)');
	opened.sqlite.run(`INSERT INTO organization (id, name, slug) VALUES ('org_a', 'Acme', 'acme'), ('org_b', 'Other', 'other'), ('org_scope', 'Scoped', 'scope')`);
	edgeId = core.nodes.join({ token: core.nodes.createJoinToken(admin, 'edge').token, name: 'edge' }).nodeId;
	workerId = core.nodes.join({ token: core.nodes.createJoinToken(admin, 'worker').token, name: 'homelab' }).nodeId;
	await core.projects.create(admin, {
		name: 'shop',
		slug: 'shop',
		runtime: 'container',
		placement: 'auto',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
	// Real principals carry member rows; the engine's legacy fallback stops once a write bumps
	// iamVersion, so seed the base bindings these fixtures stand for.
	for (const [principal, role] of [
		[admin, 'owner'],
		[viewer, 'viewer'],
		[deployer, 'deployer'],
		[outsider, 'owner'],
	] as const) {
		await core.ctx.iam.bind(admin, {
			principalType: 'user',
			principalId: principal.userId,
			roleId: role,
			scope: { type: 'org' },
		});
	}
});

describe('registry settings', () => {
	test('is off until a platform admin enables it on a node, from the dashboard only', () => {
		expect(core.registry.view(viewer)).toMatchObject({ enabled: false, host: HOST, status: 'disabled', engine: 'zot' });
		expect(() => core.registry.update(adminKey, { enabled: true, node: 'homelab' })).toThrow(/signed in to the dashboard/);
		expect(() => core.registry.update(deployer, { enabled: true, node: 'homelab' })).toThrow(/platform admin/i);
		expect(() => core.registry.update(admin, { enabled: true })).toThrow(/Choose the node/);
		const view = core.registry.update(admin, { enabled: true, node: 'homelab', keepTags: 12 });
		expect(view).toMatchObject({ enabled: true, node: { id: workerId, name: 'homelab' }, keepTags: 12, status: 'pending' });
		expect(view.realm).toBe('https://control.test/api/registry/token');
	});

	test('runs zot on its node and routes the host there from the edge', () => {
		const [desired] = core.registry.desiredForNode(workerId);
		expect(desired).toMatchObject({
			runtime: 'container',
			image: 'ghcr.io/project-zot/zot:v2.1.23',
			healthPath: '/readyz',
			registry: { engine: 'zot', version: '2.1.23', service: HOST, realm: 'https://control.test/api/registry/token', keepTags: 12 },
		});
		expect(desired!.id).toMatch(/^reg_/);
		expect(core.registry.desiredForNode(edgeId)).toEqual([]);
		expect(core.registry.routesForNode(workerId, false, () => null)).toEqual([
			{ storageId: desired!.id, host: HOST, upstream: '127.0.0.1:15000' },
		]);
		expect(core.registry.routesForNode(edgeId, true, (id) => (id === workerId ? '10.88.0.2:80' : null))).toEqual([
			{ storageId: desired!.id, host: HOST, upstream: 'http://10.88.0.2:80' },
		]);
		const activation = core.workloads.activation(workerId, desired!.id);
		expect(activation.activationVersion).toBe(desired!.activationVersion);
		lastCert = activation.env.SKIFF_REGISTRY_TOKEN_CERT!;
		expect(new X509Certificate(lastCert).subject).toBe('CN=skiff-registry-token');
		expect(activation.env.SKIFF_REGISTRY_EVENTS_URL).toMatch(/^https:\/\/control\.test\/api\/webhooks\/registry\/.+/);
		expect(() => core.workloads.activation(edgeId, desired!.id)).toThrow(/another node/);
	});

	test('records the registry node’s heartbeat status', () => {
		const [desired] = core.registry.desiredForNode(workerId);
		core.registry.applyHeartbeat(workerId, [{ id: desired!.id, status: 'running' }]);
		expect(core.registry.view(viewer).status).toBe('running');
	});
});

describe('token realm', () => {
	test('grants a member only their own org namespace and only what their role allows', () => {
		const pushed = core.registry.issueToken({ kind: 'principal', principal: deployer }, HOST, [
			'repository:acme/shop:push,pull',
			'repository:other/x:pull',
			'repository:acme/shop:delete',
		]);
		const token = decode(pushed.token);
		expect(token.aud).toBe(HOST);
		expect(token.exp - token.iat).toBe(300);
		expect(token.access).toEqual([
			{ type: 'repository', name: 'acme/shop', actions: ['push', 'pull'] },
		]);
		expect(decode(core.registry.issueToken({ kind: 'principal', principal: viewer }, HOST, ['repository:acme/shop:push,pull']).token).access).toEqual([
			{ type: 'repository', name: 'acme/shop', actions: ['pull'] },
		]);
		expect(decode(core.registry.issueToken({ kind: 'principal', principal: outsider }, HOST, ['repository:acme/shop:pull']).token).access).toEqual([]);
		// Docker's login probe: no scope, still a token.
		expect(decode(core.registry.issueToken({ kind: 'principal', principal: viewer }, null, []).token).access).toEqual([]);
	});

	test('accepts a workload or STS token for its own org, narrowed by the token scope and resources', async () => {
		opened.sqlite.run(
			`INSERT INTO service_accounts
			   (id, org_id, name, description, owner_group_id, disabled_at, created_by, created_at)
			 VALUES ('sa_registry', 'org_a', 'registry-ci', '', NULL, NULL, 'system:test', ?)`,
			[Date.now()],
		);
		core.ctx.iam.bind(admin, {
			principalType: 'serviceAccount',
			principalId: 'sa_registry',
			roleId: 'deployer',
			scope: { type: 'org' },
		});

		const workloadToken = await core.ctx.signingKeys.sign(
			'workload',
			{
				sub: 'sa_registry',
				aud: 'skiff',
				org_id: 'org_a',
				project_id: 'prj_x',
				environment: 'production',
			},
			3600,
		);
		const workloadIdentity = await verifySkiffToken(core.ctx, workloadToken);
		expect(workloadIdentity).not.toBeNull();
		const workloadPrincipal = serviceAccountPrincipalFromSkiffToken(core.ctx, workloadIdentity!);
		expect(
			decode(
				core.registry.issueToken({ kind: 'principal', principal: workloadPrincipal }, HOST, [
					'repository:acme/shop:push,pull',
					// Another org's namespace is never granted, even with a valid token.
					'repository:other/x:pull',
				]).token,
			).access,
		).toEqual([{ type: 'repository', name: 'acme/shop', actions: ['push', 'pull'] }]);

		// An STS token's scope can only narrow the account: pull at acme/shop, nothing elsewhere.
		const stsToken = await core.ctx.signingKeys.sign(
			'sts',
			{
				sub: 'sa_registry',
				aud: 'skiff',
				org_id: 'org_a',
				trust_id: 'ft_registry',
				scope: 'image:pull',
				resources: ['repository:acme/shop'],
			},
			900,
		);
		const stsIdentity = await verifySkiffToken(core.ctx, stsToken);
		expect(stsIdentity).not.toBeNull();
		const stsPrincipal = serviceAccountPrincipalFromSkiffToken(core.ctx, stsIdentity!);
		expect(
			decode(
				core.registry.issueToken({ kind: 'principal', principal: stsPrincipal }, HOST, [
					'repository:acme/shop:pull,push',
					'repository:acme/other:pull',
				]).token,
			).access,
		).toEqual([{ type: 'repository', name: 'acme/shop', actions: ['pull'] }]);

		// A resource ceiling for another repository grants nothing for this one.
		const elsewhereToken = await core.ctx.signingKeys.sign(
			'sts',
			{
				sub: 'sa_registry',
				aud: 'skiff',
				org_id: 'org_a',
				trust_id: 'ft_registry',
				scope: 'image:pull',
				resources: ['repository:acme/other'],
			},
			900,
		);
		const elsewherePrincipal = serviceAccountPrincipalFromSkiffToken(
			core.ctx,
			(await verifySkiffToken(core.ctx, elsewhereToken))!,
		);
		expect(
			decode(
				core.registry.issueToken({ kind: 'principal', principal: elsewherePrincipal }, HOST, [
					'repository:acme/shop:pull',
				]).token,
			).access,
		).toEqual([]);

		opened.sqlite.run("DELETE FROM iam_bindings WHERE principal_id = 'sa_registry'");
		opened.sqlite.run("DELETE FROM service_accounts WHERE id = 'sa_registry'");
	});

	test('a push grant creates the repository, linked to the project of the same slug', () => {
		expect(core.registry.listRepositories(viewer)).toEqual([
			expect.objectContaining({ name: 'acme/shop', projectSlug: 'shop', pushes: 0 }),
		]);
		expect(core.registry.listRepositories(outsider)).toEqual([]);
	});

	test('refuses another service, unknown logins and malformed scopes', () => {
		expect(() => core.registry.issueToken({ kind: 'principal', principal: viewer }, 'evil.test', [])).toThrow(/issues tokens for/);
		expect(() => core.registry.issueToken({ kind: 'anonymous' }, HOST, [])).toThrow(/API key/);
		expect(() => core.registry.issueToken({ kind: 'login', username: 'workload.wld_x', password: 'nope' }, HOST, [])).toThrow(/Invalid/);
		expect(decode(core.registry.issueToken({ kind: 'principal', principal: admin }, HOST, ['repository:acme/../x:pull', 'registry:catalog:*']).token).access).toEqual([]);
	});
});

describe('deploying an image from the registry', () => {
	test('pins with a self-minted token and gives the workload a login for its own repository only', async () => {
		const project = core.projects.requireRow(admin, 'shop');
		zotCalls.length = 0;
		await core.deployments.deployImage(admin, project, { image: `${HOST}/acme/shop:1` });
		expect(zotCalls[0]!.url).toBe(`https://${HOST}/v2/acme/shop/manifests/1`);
		const entry = core.workloads.desiredForNode(edgeId).concat(core.workloads.desiredForNode(workerId)).find((w) => w.projectId === project.id)!;
		expect(entry.image).toBe(`${HOST}/acme/shop@${DIGEST}`);
		const node = entry.id && core.workloads.view(project)!.nodeId!;
		const activation = core.workloads.activation(node, entry.id);
		const login = activation.registryAuth![0]!;
		expect(login).toMatchObject({ registry: HOST, username: `workload.${entry.id}` });
		const granted = decode(
			core.registry.issueToken({ kind: 'login', username: login.username, password: login.password }, HOST, [
				'repository:acme/shop:pull,push',
				'repository:acme/other:pull',
			]).token,
		);
		expect(granted.access).toEqual([{ type: 'repository', name: 'acme/shop', actions: ['pull'] }]);
	});

	test('push events update the repository; pins and unknown sinks are ignored or refused', () => {
		const secret = core.registry.desiredForNode(workerId).length
			? core.workloads.activation(workerId, core.registry.desiredForNode(workerId)[0]!.id).env.SKIFF_REGISTRY_EVENTS_URL!.split('/').pop()!
			: '';
		expect(core.registry.recordEvent(secret, 'zotregistry.image.updated', { name: 'acme/shop', reference: '2', digest: DIGEST })).toBe(true);
		expect(core.registry.recordEvent(secret, 'zotregistry.image.updated', { name: 'acme/shop', reference: 'skiff-d-dep_1', digest: DIGEST })).toBe(false);
		expect(core.registry.recordEvent(secret, 'zotregistry.repository.created', { name: 'acme/shop' })).toBe(false);
		expect(() => core.registry.recordEvent('wrong', 'zotregistry.image.updated', {})).toThrow(/Unknown event sink/);
		expect(core.registry.listRepositories(viewer)[0]).toMatchObject({ pushes: 1, lastTag: '2', lastDigest: DIGEST });
	});

	test('lists tags without deployment pins and deletes with image:delete only', async () => {
		expect(await core.registry.tags(viewer, 'acme/shop')).toEqual([{ tag: '1', digest: null }, { tag: '2', digest: null }]);
		await expect(core.registry.tags(outsider, 'acme/shop')).rejects.toThrow(/Repository/);
		await expect(core.registry.deleteTag(deployer, 'acme/shop', '1')).rejects.toThrow(/image:delete/);
		await expect(core.registry.deleteTag(admin, 'acme/shop', 'skiff-d-dep_x')).rejects.toThrow(/managed by Skiff/);
		await core.registry.deleteTag(admin, 'acme/shop', '1');
		expect(zotCalls.at(-1)).toMatchObject({ method: 'DELETE', url: `https://${HOST}/v2/acme/shop/manifests/1` });
	});

	test('a repository lists the deployments pinning it, newest first, to its own org only', () => {
		expect(core.registry.repository(viewer, 'acme/shop')).toMatchObject({ name: 'acme/shop', projectSlug: 'shop' });
		const pins = core.registry.pins(viewer, 'acme/shop');
		expect(pins).toHaveLength(1);
		expect(pins[0]).toMatchObject({ projectSlug: 'shop', digest: DIGEST });
		expect(pins[0]!.shortId).toBeTruthy();
		expect(() => core.registry.pins(outsider, 'acme/shop')).toThrow(/Repository/);
		expect(() => core.registry.repository(outsider, 'acme/shop')).toThrow(/Repository/);
	});
});

describe('GitHub Actions OIDC (G3)', () => {
	const { generateKeyPairSync, sign } = require('node:crypto') as typeof import('node:crypto');
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'gh-1', alg: 'RS256', use: 'sig' };
	const jwks = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === 'https://token.actions.githubusercontent.com/.well-known/jwks') return Response.json({ keys: [jwk] });
		return registryFetch(input, init);
	}) as typeof fetch;
	function oidcToken(claims: Record<string, unknown>, kid = 'gh-1'): string {
		const now = Math.floor(Date.now() / 1000);
		const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
		const payload = Buffer.from(
			JSON.stringify({
				iss: 'https://token.actions.githubusercontent.com',
				aud: HOST,
				sub: 'repo:acme-gh/web:ref:refs/heads/main',
				repository: 'acme-gh/web',
				ref: 'refs/heads/main',
				iat: now,
				exp: now + 300,
				...claims,
			}),
		).toString('base64url');
		return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
	}
	const login = (token: string) => ({ kind: 'login' as const, username: 'github-oidc', password: token });

	test('a trust lets one GitHub repository push to one registry repository, with no secret', async () => {
		(core.ctx.config as { registryFetch?: typeof fetch }).registryFetch = jwks;
		require('./registry-oidc.ts').resetOidcKeyCache();
		expect(() => core.registry.createOidcTrust(viewer, { githubRepository: 'acme-gh/web', repository: 'acme/web' })).toThrow(/image:credentials/);
		expect(() => core.registry.createOidcTrust(admin, { githubRepository: 'acme-gh/web', repository: 'other/web' })).toThrow(/your namespace/);
		const trust = core.registry.createOidcTrust(admin, { githubRepository: 'acme-gh/web', ref: 'refs/heads/main', repository: 'acme/web' });
		const issued = await core.registry.authorize(login(oidcToken({})), HOST, ['repository:acme/web:push,pull', 'repository:acme/other:pull']);
		expect(decode(issued.token).access).toEqual([{ type: 'repository', name: 'acme/web', actions: ['push', 'pull'] }]);
		expect(decode(issued.token).sub).toBe('github:repo:acme-gh/web:ref:refs/heads/main');
		expect(core.registry.listRepositories(viewer).map((repo) => repo.name)).toContain('acme/web');
		core.registry.deleteOidcTrust(admin, trust.id);
		await expect(core.registry.authorize(login(oidcToken({})), HOST, ['repository:acme/web:pull'])).rejects.toThrow(/No organisation trusts/);
	});

	test('refuses another ref, audience, issuer, expired tokens, unknown keys and bad signatures', async () => {
		core.registry.createOidcTrust(admin, { githubRepository: 'acme-gh/web', ref: 'refs/tags/*', repository: 'acme/*', push: false });
		const pull = await core.registry.authorize(login(oidcToken({ ref: 'refs/tags/v1' })), HOST, ['repository:acme/web:push,pull']);
		expect(decode(pull.token).access).toEqual([{ type: 'repository', name: 'acme/web', actions: ['pull'] }]);
		const refuse = (claims: Record<string, unknown>, kid?: string) =>
			core.registry.authorize(login(oidcToken(claims, kid)), HOST, ['repository:acme/web:pull']);
		await expect(refuse({ ref: 'refs/heads/feature' })).rejects.toThrow(/No organisation trusts/);
		await expect(refuse({ aud: 'sts.amazonaws.com' })).rejects.toThrow(/audience must be/);
		await expect(refuse({ iss: 'https://evil.example' })).rejects.toThrow(/not issued by GitHub/);
		await expect(refuse({ exp: Math.floor(Date.now() / 1000) - 3600 })).rejects.toThrow(/expired/);
		await expect(refuse({}, 'unknown-kid')).rejects.toThrow(/unknown key/);
		const forged = `${oidcToken({}).split('.').slice(0, 2).join('.')}.${Buffer.from('nope').toString('base64url')}`;
		await expect(core.registry.authorize(login(forged), HOST, [])).rejects.toThrow(/signature/);
	});
});

describe('GitLab CI ID tokens (D178)', () => {
	const { generateKeyPairSync, sign } = require('node:crypto') as typeof import('node:crypto');
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'gl-1', alg: 'RS256', use: 'sig' };
	const ISSUER = 'https://gitlab.example.com';
	const jwks = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === `${ISSUER}/oauth/discovery/keys`) return Response.json({ keys: [jwk] });
		return registryFetch(input, init);
	}) as typeof fetch;
	function idToken(claims: Record<string, unknown>): string {
		const now = Math.floor(Date.now() / 1000);
		const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'gl-1' })).toString('base64url');
		const payload = Buffer.from(
			JSON.stringify({
				iss: ISSUER,
				aud: HOST,
				sub: 'project_path:acme-gl/platform/web:ref_type:branch:ref:main',
				project_path: 'acme-gl/platform/web',
				ref: 'main',
				ref_type: 'branch',
				iat: now,
				exp: now + 300,
				...claims,
			}),
		).toString('base64url');
		return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
	}
	const login = (token: string) => ({ kind: 'login' as const, username: 'gitlab-oidc', password: token });

	test('a gitlab trust lets one project push from its branch, keyed by issuer', async () => {
		(core.ctx.config as { registryFetch?: typeof fetch }).registryFetch = jwks;
		require('./registry-oidc.ts').resetOidcKeyCache();
		expect(() => core.registry.createOidcTrust(admin, { provider: 'gitlab', repository: 'acme/web' })).toThrow(/project path/);
		const trust = core.registry.createOidcTrust(admin, {
			provider: 'gitlab',
			gitlabProject: 'acme-gl/platform/web',
			issuer: `${ISSUER}/`,
			ref: 'refs/heads/main',
			repository: 'acme/gl-web',
		});
		expect(trust).toMatchObject({ provider: 'gitlab', subject: 'acme-gl/platform/web', issuer: ISSUER });
		const issued = await core.registry.authorize(login(idToken({})), HOST, ['repository:acme/gl-web:push,pull']);
		expect(decode(issued.token).access).toEqual([{ type: 'repository', name: 'acme/gl-web', actions: ['push', 'pull'] }]);
		expect(decode(issued.token).sub).toBe('gitlab:project_path:acme-gl/platform/web:ref_type:branch:ref:main');
		const refuse = (claims: Record<string, unknown>) => core.registry.authorize(login(idToken(claims)), HOST, ['repository:acme/gl-web:pull']);
		await expect(refuse({ ref: 'feature' })).rejects.toThrow(/No organisation trusts GitLab project/);
		await expect(refuse({ ref: 'main', ref_type: 'tag' })).rejects.toThrow(/refs\/tags\/main/);
		await expect(refuse({ iss: 'https://gitlab.com' })).rejects.toThrow(/No organisation trusts ID tokens/);
		await expect(refuse({ aud: 'other' })).rejects.toThrow(/audience must be/);
		await expect(refuse({ project_path: 'acme-gl/other' })).rejects.toThrow(/No organisation trusts/);
		core.registry.deleteOidcTrust(admin, trust.id);
	});
});

describe('mirrors, signatures, CVEs, S3 and quotas (G2, G4–G6)', () => {
	const COSIGN_KEY = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEexample\n-----END PUBLIC KEY-----';
	let graphql: Record<string, unknown> = {};
	const uploads: string[] = [];
	const extended = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.startsWith(`https://${HOST}/v2/_zot/ext/search`)) return Response.json({ data: graphql });
		if (url === `https://${HOST}/v2/_zot/ext/cosign`) {
			uploads.push(`${new Headers(init.headers).get('authorization')?.slice(0, 6)}|${String(init.body).slice(0, 26)}`);
			return new Response(null, { status: 200 });
		}
		if (url.endsWith('/v2/acme/shop/tags/list')) return Response.json({ tags: ['1'] });
		if (url.endsWith('/v2/acme/shop/manifests/1'))
			return Response.json(
				{ config: { digest: 'sha256:c1', size: 100 }, layers: [{ digest: 'sha256:l1', size: 1000 }, { digest: 'sha256:l2', size: 500 }] },
				{ headers: { 'Docker-Content-Digest': DIGEST } },
			);
		return registryFetch(input, init);
	}) as typeof fetch;

	test('mirrors: nodes get the mirror and pull through it with their node token, and nothing else', () => {
		(core.ctx.config as { registryFetch?: typeof fetch }).registryFetch = extended;
		core.registry.update(admin, { mirrors: ['docker.io', 'ghcr.io'] });
		expect(core.registry.mirrorForNodes()).toEqual({ host: HOST, upstreams: ['docker.io', 'ghcr.io'] });
		const [desired] = core.registry.desiredForNode(workerId);
		expect(desired!.registry).toMatchObject({ mirrors: ['docker.io', 'ghcr.io'], trust: false, cve: false, s3: null });
		const nodeToken = core.nodes.join({ token: core.nodes.createJoinToken(admin, 'worker').token, name: 'mirror-node' });
		const node = { kind: 'login' as const, username: `node.${nodeToken.nodeId}`, password: nodeToken.token };
		expect(decode(core.registry.issueToken(node, HOST, ['repository:docker.io/library/nginx:pull,push', 'repository:acme/shop:pull']).token).access).toEqual([
			{ type: 'repository', name: 'docker.io/library/nginx', actions: ['pull'] },
		]);
		expect(decode(core.registry.issueToken(node, HOST, ['repository:quay.io/x/y:pull']).token).access).toEqual([]);
		expect(() => core.registry.issueToken({ ...node, password: 'wrong' }, HOST, [])).toThrow(/Invalid/);
		expect(decode(core.registry.issueToken({ kind: 'principal', principal: viewer }, HOST, ['repository:ghcr.io/o/r:pull,push']).token).access).toEqual([
			{ type: 'repository', name: 'ghcr.io/o/r', actions: ['pull'] },
		]);
	});

	test('settings refuse CVE scanning with S3 and bad keys; S3 secrets reach only the activation', () => {
		expect(() => core.registry.update(admin, { cveScanning: true, s3: { endpoint: 'https://s3.example.com', bucket: 'images', accessKeyId: 'AKIA1', secretAccessKey: 'secret-123', cacheUrl: 'redis://cache:6379' } })).toThrow(/CVE/);
		expect(() => core.registry.update(admin, { cosignKeys: ['not a key at all, just some text here that is long enough'] })).toThrow(/PEM public key/);
		const view = core.registry.update(admin, {
			s3: { endpoint: 'https://s3.example.com:9000', bucket: 'images', accessKeyId: 'AKIA1', secretAccessKey: 'secret-123', cacheUrl: 'redis://cache:6379/0' },
		});
		expect(view.s3).toEqual({ endpoint: 'https://s3.example.com:9000', bucket: 'images', region: 'us-east-1' });
		expect(JSON.stringify(view)).not.toContain('secret-123');
		const [desired] = core.registry.desiredForNode(workerId);
		expect(desired!.registry!.s3).toEqual({ endpoint: 's3.example.com:9000', bucket: 'images', region: 'us-east-1', secure: true });
		const activation = core.workloads.activation(workerId, desired!.id);
		expect(activation.env).toMatchObject({
			SKIFF_REGISTRY_S3_ACCESS_KEY: 'AKIA1',
			SKIFF_REGISTRY_S3_SECRET_KEY: 'secret-123',
			SKIFF_REGISTRY_CACHE_URL: 'redis://cache:6379/0',
		});
		core.registry.update(admin, { s3: null });
	});

	test('signatures: keys upload as the zot admin; enforce refuses an unsigned own image, warn deploys it', async () => {
		const view = core.registry.update(admin, { signatures: 'enforce', cosignKeys: [COSIGN_KEY], cveScanning: true });
		expect(view).toMatchObject({ signatures: 'enforce', cosignKeys: 1, cveScanning: true });
		const [desired] = core.registry.desiredForNode(workerId);
		expect(desired!.registry).toMatchObject({ trust: true, cve: true });
		expect(core.workloads.activation(workerId, desired!.id).env.SKIFF_REGISTRY_ADMIN_HTPASSWD).toMatch(/^skiff-admin:\$2[aby]\$10\$/);
		expect(await core.registry.syncTrustKeys()).toBe(true);
		expect(await core.registry.syncTrustKeys()).toBe(true);
		expect(uploads).toEqual(['Basic |-----BEGIN PUBLIC KEY-----']);
		expect(core.registry.view(viewer).cosignKeysPending).toBe(false);

		const project = core.projects.requireRow(admin, 'shop');
		graphql = { Image: { IsSigned: false, SignatureInfo: [] } };
		await expect(core.deployments.deployImage(admin, project, { image: `${HOST}/acme/shop:1` })).rejects.toThrow(/not signed/);
		graphql = { Image: { IsSigned: true, SignatureInfo: [{ Tool: 'cosign', IsTrusted: false, Author: 'x' }] } };
		await expect(core.deployments.deployImage(admin, project, { image: `${HOST}/acme/shop:1` })).rejects.toThrow(/not by a trusted key/);
		graphql = { Image: { IsSigned: true, SignatureInfo: [{ Tool: 'cosign', IsTrusted: true, Author: 'ci' }] } };
		await core.deployments.deployImage(admin, project, { image: `${HOST}/acme/shop:1` });
		core.registry.update(admin, { signatures: 'warn' });
		graphql = { Image: { IsSigned: false, SignatureInfo: [] } };
		await core.deployments.deployImage(admin, project, { image: `${HOST}/acme/shop:1` });
		expect(core.workloads.view(core.projects.requireRow(admin, 'shop'))?.imageDigest).toBe(DIGEST);
	});

	test('CVE summaries come from the registry scan, most severe first', async () => {
		graphql = {
			CVEListForImage: {
				Summary: { MaxSeverity: 'HIGH', Count: 2, HighCount: 1, LowCount: 1 },
				CVEList: [
					{ Id: 'CVE-2', Severity: 'LOW', Title: 'meh' },
					{ Id: 'CVE-1', Severity: 'HIGH', Title: 'bad' },
				],
			},
		};
		const report = await core.registry.vulnerabilities(viewer, 'acme/shop', '1');
		expect(report.summary).toMatchObject({ MaxSeverity: 'HIGH', Count: 2 });
		expect(report.cves.map((cve) => cve.Id)).toEqual(['CVE-1', 'CVE-2']);
		await expect(core.registry.vulnerabilities(viewer, 'acme/shop', 'bad tag!')).rejects.toThrow(/tag or a sha256/);
	});

	test('usage is sampled per repository, and pushes stop at the registry quota', async () => {
		expect(await core.registry.sampleUsage({ force: true })).toBeGreaterThan(0);
		expect(core.registry.listRepositories(viewer).find((repo) => repo.name === 'acme/shop')?.bytes).toBe(1600);
		expect(core.registry.usedBytes('org_a')).toBeGreaterThanOrEqual(1600);
		core.ctx.quota.set('org_a', { registryBytes: 1000 });
		expect(core.registry.usage(viewer)).toMatchObject({ limitBytes: 1000 });
		expect(() => core.registry.issueToken({ kind: 'principal', principal: deployer }, HOST, ['repository:acme/shop:push,pull'])).toThrow(/registryBytes/);
		// Pulls are never refused.
		expect(decode(core.registry.issueToken({ kind: 'principal', principal: viewer }, HOST, ['repository:acme/shop:pull']).token).access).toHaveLength(1);
		core.ctx.quota.set('org_a', { registryBytes: -1 });
	});
});

describe('resource-scoped access', () => {
	test('a repository binding covers only that registry repository', () => {
		const scopedOwner = buildPrincipal({
			kind: 'user',
			userId: 'user_scope_owner',
			orgId: 'org_scope',
			role: 'owner',
		});
		core.registry.issueToken({ kind: 'principal', principal: scopedOwner }, HOST, ['repository:scope/visible:push']);
		core.registry.issueToken({ kind: 'principal', principal: scopedOwner }, HOST, ['repository:scope/hidden:push']);
		const visible = opened.sqlite
			.query<{ id: string }, [string]>('SELECT id FROM registry_repositories WHERE name = ?')
			.get('scope/visible')!;
		expect(visible.id).toBeTruthy();

		core.ctx.iam.bind(scopedOwner, {
			principalType: 'user',
			principalId: 'user_scope_owner',
			roleId: 'owner',
			scope: { type: 'org' },
		});
		core.ctx.iam.bind(scopedOwner, {
			principalType: 'user',
			principalId: 'user_registry_guest',
			roleId: 'viewer',
			scope: { type: 'repository', id: visible.id },
		});

		const guest = buildPrincipal({
			kind: 'user',
			userId: 'user_registry_guest',
			orgId: 'org_scope',
			role: 'viewer',
		});
		expect(core.registry.repository(guest, 'scope/visible').name).toBe('scope/visible');
		expect(core.registry.pins(guest, 'scope/visible')).toEqual([]);
		expect(() => core.registry.repository(guest, 'scope/hidden')).toThrow(/image:pull/);
		expect(() => core.registry.pins(guest, 'scope/hidden')).toThrow(/image:pull/);
	});
});

describe('registry image prune', () => {
	test('describes tag age and deletes only tags past retention beyond the keep count', async () => {
		core.registry.update(admin, { enabled: true, node: 'homelab', keepTags: 1 });
		opened.sqlite.run(
			`INSERT OR IGNORE INTO registry_repositories (id, org_id, name, created_by, created_at)
			 VALUES ('rr_prune_shop', 'org_a', 'acme/prune', 'user_1', ?)`,
			[Date.now()],
		);
		const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
		const now = new Date().toISOString();
		const deleted: string[] = [];
		const pruneFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith('/v2/acme/prune/tags/list')) return Response.json({ tags: ['latest', 'new', 'old'] });
			const manifest = /\/v2\/acme\/prune\/manifests\/(.+)$/.exec(url);
			if (manifest) {
				if (init.method === 'DELETE') {
					deleted.push(manifest[1]!);
					return new Response(null, { status: 202 });
				}
				const created = manifest[1] === 'old' ? old : now;
				const digest = `sha256:${(manifest[1] === 'old' ? 'a' : manifest[1] === 'new' ? 'b' : 'c').repeat(64)}`;
				return Response.json(
					{
						schemaVersion: 2,
						config: { digest: 'sha256:cfg', size: 10 },
						layers: [{ digest: 'sha256:layer', size: 100 }],
						annotations: { 'org.opencontainers.image.created': created },
					},
					{ headers: { 'Docker-Content-Digest': digest } },
				);
			}
			return new Response(null, { status: 404 });
		}) as typeof fetch;
		const previous = (core.ctx.config as { registryFetch?: typeof fetch }).registryFetch;
		(core.ctx.config as { registryFetch?: typeof fetch }).registryFetch = pruneFetch;
		try {
			const described = await core.registry.describeTags('acme/prune');
			expect(described.find((tag) => tag.tag === 'old')?.createdAt).toBe(Date.parse(old));
			expect(described.find((tag) => tag.tag === 'old')?.bytes).toBe(100);

			const created = core.operations.create(admin, {
				action: 'prune',
				categories: ['registry_images'],
				keepTags: 1,
			});
			await core.operations.settled(created.id);
			const planned = core.operations.get(admin, created.id);
			expect(planned.status).toBe('planned');
			const items = core.operations.items(admin, planned.id).items;
			expect(items.map((item) => item.targetId)).toEqual(['acme/prune:old']);

			core.operations.apply(admin, planned.id);
			await core.operations.settled(planned.id);
			const done = core.operations.get(admin, planned.id);
			expect(done.status).toBe('succeeded');
			expect(deleted).toEqual(['old']);
		} finally {
			(core.ctx.config as { registryFetch?: typeof fetch }).registryFetch = previous;
		}
	});
});

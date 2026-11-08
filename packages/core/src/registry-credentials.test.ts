import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { DEFAULT_FEATURES } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

/** A fake ghcr.io: anonymous HEAD → 401 Bearer challenge; the token realm checks Basic auth. */
let currentDigest = DIGEST_A;
let registryDown = false;
const calls: Array<{ url: string; authorization: string | null }> = [];
const registryFetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = String(input instanceof Request ? input.url : input);
	const headers = new Headers(init?.headers);
	calls.push({ url, authorization: headers.get('authorization') });
	if (registryDown) throw new Error('connect ECONNREFUSED');
	if (url.startsWith('https://ghcr.io/token')) {
		const expected = `Basic ${Buffer.from('robot:pat-123').toString('base64')}`;
		if (headers.get('authorization') !== expected) return new Response('denied', { status: 401 });
		return Response.json({ token: 'tok-1' });
	}
	if (url.startsWith('https://ghcr.io/v2/acme/api/manifests/')) {
		if (headers.get('authorization') !== 'Bearer tok-1')
			return new Response(null, {
				status: 401,
				headers: {
					'WWW-Authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:acme/api:pull"',
				},
			});
		return new Response(null, { status: 200, headers: { 'Docker-Content-Digest': currentDigest } });
	}
	return new Response('not found', { status: 404 });
}) as typeof fetch;

const dir = mkdtempSync(join(tmpdir(), 'skiff-registry-credentials-'));
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

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const deployer = buildPrincipal({ kind: 'user', userId: 'user_3', orgId: 'org_1', role: 'deployer' });
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_2', role: 'owner' });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });
let edgeId = '';

const spec = (image: string, extra: Record<string, unknown> = {}) =>
	({ runtime: 'container', image, port: 8080, memoryMb: 256, cpus: 1, healthPath: '/', env: {}, secrets: [], ...extra }) as never;

function failure(fn: () => unknown): { status: number; message: string } {
	try {
		fn();
	} catch (error) {
		return error as { status: number; message: string };
	}
	throw new Error('expected the call to throw');
}

async function deploy(slug: string) {
	return core.uploads.deployInline(owner, core.projects.requireRow(owner, slug), [file('README', `x${Date.now()}${Math.random()}`)], {
		promote: true,
	});
}

function desired(slug: string) {
	const project = core.projects.requireRow(owner, slug);
	return core.workloads.desiredForNode(edgeId).find((entry) => entry.projectId === project.id)!;
}

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeAll(async () => {
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
	edgeId = joined.nodeId;
	for (const slug of ['shop', 'local'])
		await core.projects.create(owner, {
			name: slug,
			slug,
			runtime: 'container',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
});

describe('registry credentials', () => {
	test('create, list, update and delete without ever returning the password', () => {
		const created = core.registryCredentials.create(owner, {
			name: 'ghcr',
			registry: 'GHCR.io',
			username: 'robot',
			password: 'wrong',
		});
		expect(created).toMatchObject({ name: 'ghcr', registry: 'ghcr.io', username: 'robot', lastUsedAt: null });
		expect(JSON.stringify(created)).not.toContain('wrong');
		expect(core.registryCredentials.list(viewer).map((row) => row.name)).toEqual(['ghcr']);
		expect(core.registryCredentials.list(otherOrg)).toEqual([]);
		const updated = core.registryCredentials.update(owner, 'ghcr', { password: 'pat-123' });
		expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
		expect(core.registryCredentials.loginForImage('org_1', 'ghcr.io/acme/api:1')).toEqual({
			username: 'robot',
			password: 'pat-123',
		});
	});

	test('one credential per registry host, Docker Hub aliases included', () => {
		expect(
			failure(() => core.registryCredentials.create(owner, { name: 'ghcr-two', registry: 'ghcr.io', username: 'x', password: 'y' })).status,
		).toBe(409);
		core.registryCredentials.create(owner, { name: 'hub', registry: 'index.docker.io', username: 'me', password: 'tok' });
		expect(core.registryCredentials.loginForImage('org_1', 'nginx:1.27')?.username).toBe('me');
		expect(core.registryCredentials.loginForImage('org_1', 'docker.io/library/nginx')?.username).toBe('me');
		expect(core.registryCredentials.loginForImage('org_1', 'localhost/app:1')).toBeNull();
		core.registryCredentials.remove(owner, 'hub');
		expect(core.registryCredentials.loginForImage('org_1', 'nginx:1.27')).toBeNull();
	});

	test('managing credentials needs image:credentials; viewers can only list', () => {
		expect(() => core.registryCredentials.create(viewer, { name: 'quay', registry: 'quay.io', username: 'x', password: 'y' })).toThrow(
			'Missing permission image:credentials',
		);
		expect(() => core.registryCredentials.remove(viewer, 'ghcr')).toThrow('Missing permission image:credentials');
		const created = core.registryCredentials.create(deployer, { name: 'quay', registry: 'quay.io', username: 'x', password: 'y' });
		expect(created.registry).toBe('quay.io');
		core.registryCredentials.remove(deployer, 'quay');
		expect(failure(() => core.registryCredentials.remove(owner, 'quay')).status).toBe(404);
	});

	test('rejects a localhost registry and bad names', () => {
		expect(() => core.registryCredentials.create(owner, { name: 'local', registry: 'localhost', username: 'x', password: 'y' })).toThrow();
		expect(() => core.registryCredentials.create(owner, { name: 'Bad Name', registry: 'example.com', username: 'x', password: 'y' })).toThrow();
	});
});

describe('digest pinning (R1) and activation credentials (R2)', () => {
	test('a deploy pins the tag to its digest with the stored credential', async () => {
		core.workloads.setSpec(owner, core.projects.requireRow(owner, 'shop'), spec('ghcr.io/acme/api:1.0'));
		calls.length = 0;
		await deploy('shop');
		expect(calls.some((call) => call.url.startsWith('https://ghcr.io/token') && call.authorization?.startsWith('Basic '))).toBe(true);
		const entry = desired('shop');
		expect(entry.image).toBe(`ghcr.io/acme/api@${DIGEST_A}`);
		expect(core.workloads.view(core.projects.requireRow(owner, 'shop'))).toBeTruthy();
	});

	test('the activation carries the credential, and records its use', () => {
		const entry = desired('shop');
		const activation = core.workloads.activation(edgeId, entry.id);
		expect(activation.registryAuth).toEqual([{ registry: 'ghcr.io', username: 'robot', password: 'pat-123' }]);
		expect(core.registryCredentials.list(owner).find((row) => row.name === 'ghcr')?.lastUsedAt).not.toBeNull();
	});

	test('saving other fields keeps the pin; a moved tag is picked up only by the next deploy', async () => {
		const before = desired('shop');
		currentDigest = DIGEST_B;
		core.workloads.setSpec(owner, core.projects.requireRow(owner, 'shop'), spec('ghcr.io/acme/api:1.0', { memoryMb: 300 }));
		expect(desired('shop').image).toBe(`ghcr.io/acme/api@${DIGEST_A}`);
		expect(desired('shop').activationVersion).toBe(before.activationVersion);
		await deploy('shop');
		const after = desired('shop');
		expect(after.image).toBe(`ghcr.io/acme/api@${DIGEST_B}`);
		expect(after.activationVersion).not.toBe(before.activationVersion);
	});

	test('rollback restores the earlier digest', async () => {
		const project = core.projects.requireRow(owner, 'shop');
		const list = core.deployments.list(owner, project);
		const older = list.find((row) => row.id !== list[0]!.id)!;
		await core.deployments.promote(owner, project, older.id);
		expect(desired('shop').image).toBe(`ghcr.io/acme/api@${DIGEST_A}`);
	});

	test('a new image runs by tag until deployed; an input digest is ignored', () => {
		core.workloads.setSpec(owner, core.projects.requireRow(owner, 'shop'), spec('ghcr.io/acme/api:2.0', { imageDigest: DIGEST_B }));
		expect(desired('shop').image).toBe('ghcr.io/acme/api:2.0');
	});

	test('an unreachable registry deploys by tag instead of failing', async () => {
		registryDown = true;
		try {
			await deploy('shop');
			expect(desired('shop').image).toBe('ghcr.io/acme/api:2.0');
		} finally {
			registryDown = false;
		}
	});

	test('localhost images are never resolved and carry no credential', async () => {
		core.workloads.setSpec(owner, core.projects.requireRow(owner, 'local'), spec('localhost/app:1'));
		calls.length = 0;
		await deploy('local');
		expect(calls).toEqual([]);
		const entry = desired('local');
		expect(entry.image).toBe('localhost/app:1');
		expect(core.workloads.activation(edgeId, entry.id).registryAuth).toBeUndefined();
	});

	test('an image already pinned by digest runs without its tag', async () => {
		core.workloads.setSpec(owner, core.projects.requireRow(owner, 'local'), spec(`ghcr.io/acme/api:1.0@${DIGEST_A}`));
		calls.length = 0;
		await deploy('local');
		expect(calls).toEqual([]);
		expect(desired('local').image).toBe(`ghcr.io/acme/api@${DIGEST_A}`);
	});
});

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAction } from './actions.ts';
import { MEDIA_TYPES, RegistryClient, createImageIndex, parseChallenge, parseImageReference, sha256Digest } from './image-registry.ts';
import { startFakeRegistry, testHost, type FakeRegistry } from './image-test-fixtures.ts';
import { jobClaim } from './test-server.ts';

const registries: FakeRegistry[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const registry of registries.splice(0)) registry.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function registry(username = 'ci', password = 'pw-secret'): FakeRegistry {
	const fake = startFakeRegistry({ username, password });
	registries.push(fake);
	return fake;
}

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'skiff-image-index-'));
	dirs.push(dir);
	return dir;
}

function json(bytes: Uint8Array | undefined): Record<string, any> {
	return JSON.parse(new TextDecoder().decode(bytes!)) as Record<string, any>;
}

describe('references and challenges', () => {
	test('parses references like docker does', () => {
		expect(parseImageReference('ghcr.io/acme/api:1')).toEqual({ registry: 'ghcr.io', repository: 'acme/api', tag: '1', digest: null });
		expect(parseImageReference('localhost:5000/api')).toEqual({ registry: 'localhost:5000', repository: 'api', tag: null, digest: null });
		expect(parseImageReference('postgres:18')).toEqual({ registry: 'docker.io', repository: 'library/postgres', tag: '18', digest: null });
		const digest = `sha256:${'a'.repeat(64)}`;
		expect(parseImageReference(`r.example.com:8443/acme/api:1@${digest}`)).toEqual({ registry: 'r.example.com:8443', repository: 'acme/api', tag: '1', digest });
		expect(() => parseImageReference('ghcr.io/Acme/api')).toThrow(/Invalid repository/);
		expect(() => parseImageReference('ghcr.io/acme/api@sha256:abc')).toThrow(/digest/);
	});

	test('parses Bearer and Basic challenges', () => {
		expect(parseChallenge('Bearer realm="https://auth.example/token",service="registry.example",scope="repository:a/b:pull,push"')).toEqual({
			scheme: 'bearer',
			params: { realm: 'https://auth.example/token', service: 'registry.example', scope: 'repository:a/b:pull,push' },
		});
		expect(parseChallenge('Basic realm="zot"')).toEqual({ scheme: 'basic', params: { realm: 'zot' } });
	});
});

describe('createImageIndex against a registry with a token challenge', () => {
	test('joins a plain manifest and a BuildKit index (with attestation) into one OCI index', async () => {
		const fake = registry();
		const amd = fake.seedImage('acme/app', '1-x64', { os: 'linux', architecture: 'amd64' });
		const armImage = fake.seedImage('acme/app', null, { os: 'linux', architecture: 'arm64', variant: 'v8' });
		const armSize = fake.manifest('acme/app', armImage)!.bytes.byteLength;
		const attestation = fake.seedManifest('acme/app', null, MEDIA_TYPES.ociManifest, { schemaVersion: 2, mediaType: MEDIA_TYPES.ociManifest, layers: [] });
		const buildkitIndex = fake.seedManifest('acme/app', '1-arm64', MEDIA_TYPES.ociIndex, {
			schemaVersion: 2,
			mediaType: MEDIA_TYPES.ociIndex,
			manifests: [
				{ mediaType: MEDIA_TYPES.ociManifest, digest: armImage, size: armSize, platform: { os: 'linux', architecture: 'arm64', variant: 'v8' } },
				{
					mediaType: MEDIA_TYPES.ociManifest,
					digest: attestation.digest,
					size: attestation.size,
					platform: { os: 'unknown', architecture: 'unknown' },
					annotations: { 'vnd.docker.reference.digest': armImage, 'vnd.docker.reference.type': 'attestation-manifest' },
				},
			],
		});
		const client = new RegistryClient({ credentials: (host) => (host === fake.host ? { username: 'ci', password: 'pw-secret' } : null), tempDir: tempDir() });
		const result = await createImageIndex(client, { target: `${fake.host}/acme/app:1`, sources: [`${fake.host}/acme/app:1-x64`, buildkitIndex.digest], annotations: { 'org.opencontainers.image.revision': 'abc' } });

		const stored = fake.manifest('acme/app', '1')!;
		expect(stored.mediaType).toBe(MEDIA_TYPES.ociIndex);
		expect(result.digest).toBe(sha256Digest(stored.bytes));
		expect(result.image).toBe(`${fake.host}/acme/app@${result.digest}`);
		const index = json(stored.bytes);
		expect(index.mediaType).toBe(MEDIA_TYPES.ociIndex);
		expect(index.annotations).toEqual({ 'org.opencontainers.image.revision': 'abc' });
		expect(index.manifests.map((entry: any) => [entry.digest, entry.platform])).toEqual([
			[amd, { os: 'linux', architecture: 'amd64' }],
			[armImage, { os: 'linux', architecture: 'arm64', variant: 'v8' }],
			[attestation.digest, { os: 'unknown', architecture: 'unknown' }],
		]);
		expect(index.manifests[0].size).toBe(fake.manifest('acme/app', amd)!.bytes.byteLength);
		// The token dance happened, and object-storage redirects never saw the bearer token.
		expect(fake.tokenRequests.length).toBeGreaterThan(0);
		expect(fake.tokenRequests.flat()).toContain('repository:acme/app:pull,push');
		expect(fake.leakedAuth).toEqual([]);
	});

	test('copies sources from another repository (mount) and another registry (upload)', async () => {
		const a = registry('ci', 'pw-a');
		const b = registry('mirror', 'pw-b');
		const amd = a.seedImage('acme/app', '1-x64', { os: 'linux', architecture: 'amd64' });
		const arm = a.seedImage('acme/app', '1-arm64', { os: 'linux', architecture: 'arm64' });
		const credentials = (host: string) => (host === a.host ? { username: 'ci', password: 'pw-a' } : host === b.host ? { username: 'mirror', password: 'pw-b' } : null);
		const client = new RegistryClient({ credentials, tempDir: tempDir() });

		await createImageIndex(client, { target: `${a.host}/acme/other:1`, sources: [`${a.host}/acme/app:1-x64`, `${a.host}/acme/app@${arm}`] });
		expect(a.mounts.length).toBe(4);
		expect(a.manifest('acme/other', amd)).toBeDefined();
		expect(json(a.manifest('acme/other', '1')!.bytes).manifests).toHaveLength(2);

		const mirrored = await createImageIndex(client, { target: `${b.host}/kieran/app:1`, sources: [`${a.host}/acme/app:1-x64`, `${a.host}/acme/app:1-arm64`] });
		expect(b.uploads.length).toBe(4);
		expect(b.manifest('kieran/app', arm)).toBeDefined();
		expect(mirrored.digest).toBe(sha256Digest(b.manifest('kieran/app', '1')!.bytes));
		expect(a.leakedAuth).toEqual([]);
	});

	test('refuses two images of one platform, and reports bad credentials', async () => {
		const fake = registry();
		fake.seedImage('acme/app', 'a', { os: 'linux', architecture: 'amd64' });
		fake.seedImage('acme/app', 'b', { os: 'linux', architecture: 'amd64' });
		const good = new RegistryClient({ credentials: () => ({ username: 'ci', password: 'pw-secret' }) });
		await expect(createImageIndex(good, { target: `${fake.host}/acme/app:1`, sources: [`${fake.host}/acme/app:a`, `${fake.host}/acme/app:b`] })).rejects.toThrow(
			/linux\/amd64/,
		);
		const bad = new RegistryClient({ credentials: () => ({ username: 'ci', password: 'nope' }) });
		await expect(createImageIndex(bad, { target: `${fake.host}/acme/app:1`, sources: [`${fake.host}/acme/app:a`] })).rejects.toThrow(/Token request .* 401/);
	});
});

describe('skiff/image-index action', () => {
	test('expands registry/ tags, logs in as the job and outputs the index digest', async () => {
		const token = 'job-token-123';
		const fake = registry('job.job_test1', token);
		fake.seedImage('acme/api', 'sha-x64', { os: 'linux', architecture: 'amd64' });
		fake.seedImage('acme/api', 'sha-arm64', { os: 'linux', architecture: 'arm64' });
		const dir = tempDir();
		const claim = { ...jobClaim({ steps: [] }), registry: { host: fake.host, namespace: `${fake.host}/acme`, push: true } };
		const host = testHost({ claim, workspace: dir, temp: join(dir, 'tmp') });
		const result = await runAction('skiff/image-index', { tag: 'registry/api:sha', sources: 'registry/api:sha-x64\nregistry/api:sha-arm64' }, host);
		expect(host.lines.join('\n')).not.toContain(token);
		expect(result.outcome).toBe('success');
		expect(result.outputs.digest).toBe(sha256Digest(fake.manifest('acme/api', 'sha')!.bytes));
		expect(result.outputs.image).toBe(`${fake.host}/acme/api@${result.outputs.digest}`);
		expect(result.outputs.platforms).toBe('linux/amd64,linux/arm64');

		const untrusted = testHost({ claim: { ...claim, registry: { ...claim.registry, push: false } }, workspace: dir, temp: join(dir, 'tmp') });
		const refused = await runAction('skiff/image-index', { tag: 'registry/api:sha', sources: 'registry/api:sha-x64' }, untrusted);
		expect(refused.outcome).toBe('failure');
		expect(untrusted.lines.join('\n')).toContain('cannot push');
	});
});

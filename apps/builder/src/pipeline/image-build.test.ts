import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineJobClaim } from '@skiff/contracts';
import { builderEnv, runAction } from './actions.ts';
import { attestationInputs, buildctlArgs, buildkitCacheScope, checkBuildArgs, parseSecretInputs, platformInput, sanitizeCacheScope } from './image-build.ts';
import { testHost } from './image-test-fixtures.ts';
import { jobClaim } from './test-server.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('input parsing', () => {
	test('secrets are id=VALUE lines; continuation lines belong to the previous secret', () => {
		expect(parseSecretInputs('npmrc=//registry/:_authToken=abc\nkey=-----BEGIN\nline two\n-----END\n')).toEqual([
			{ id: 'npmrc', value: '//registry/:_authToken=abc' },
			{ id: 'key', value: '-----BEGIN\nline two\n-----END' },
		]);
		expect(() => parseSecretInputs('a=1\na=2')).toThrow(/Duplicate/);
		expect(() => parseSecretInputs('no equals here')).toThrow(/id=VALUE/);
		expect(parseSecretInputs(undefined)).toEqual([]);
	});

	test('build-args never carry a secret value', () => {
		const secrets = [{ id: 'token', value: 'hunter2' }];
		expect(checkBuildArgs(['A=1'], () => false, secrets)).toEqual(['A=1']);
		expect(() => checkBuildArgs(['TOKEN=hunter2'], () => false, secrets)).toThrow(/must not contain secrets/);
		expect(() => checkBuildArgs(['X=masked'], (text) => text.includes('masked'), [])).toThrow(/must not contain secrets/);
		expect(() => checkBuildArgs(['bad line'], () => false, [])).toThrow(/KEY=VALUE/);
	});

	test('attestations: min provenance and an SBOM when pushing, max is opt-in', () => {
		expect(attestationInputs({}, true)).toEqual({ provenance: 'min', sbom: true });
		expect(attestationInputs({}, false)).toEqual({ provenance: null, sbom: false });
		expect(attestationInputs({ provenance: 'mode=max', sbom: 'false' }, true)).toEqual({ provenance: 'max', sbom: false });
		expect(attestationInputs({ provenance: 'false' }, true)).toEqual({ provenance: null, sbom: true });
		expect(() => attestationInputs({ provenance: 'loud' }, true)).toThrow(/provenance/);
	});

	test('platforms and cache scopes', () => {
		expect(platformInput('native')).toBeNull();
		expect(platformInput('linux/arm64, linux/amd64')).toBe('linux/arm64,linux/amd64');
		expect(() => platformInput('arm64')).toThrow(/Invalid platform/);
		expect(sanitizeCacheScope('untrusted:refs/pull/7/merge')).toBe('untrusted-refs-pull-7-merge');
		const claim = { trust: 'trusted' as const, checkout: { ref: 'refs/heads/main', sha: 'a' }, buildkitCacheScope: null };
		expect(buildkitCacheScope(claim, {})).toBe('trusted');
		expect(buildkitCacheScope({ ...claim, buildkitCacheScope: 'repo_1/trusted/main' }, {})).toBe('repo_1-trusted-main');
		expect(buildkitCacheScope(claim, { SKIFF_CACHE_SCOPE: 'custom' })).toBe('custom');
		const untrusted = { ...claim, trust: 'untrusted' as const, checkout: { ref: 'refs/pull/7/merge', sha: 'a' } };
		expect(buildkitCacheScope(untrusted, {})).toBe('untrusted-refs-pull-7-merge');
		// An untrusted run cannot name its way into the trusted scope.
		expect(buildkitCacheScope(untrusted, { SKIFF_CACHE_SCOPE: 'trusted' })).toBe('untrusted-trusted');
	});

	test('buildctl argv', () => {
		expect(
			buildctlArgs({
				context: '/w',
				dockerfileDir: '/w/docker',
				filename: 'Dockerfile',
				tags: ['r/a:1', 'r/a:latest'],
				push: true,
				target: 'runtime',
				platform: 'linux/arm64',
				buildArgs: ['A=1'],
				labels: ['org.opencontainers.image.revision=abc'],
				secrets: [{ id: 'npmrc', src: '/t/s/0' }],
				attestations: { provenance: 'min', sbom: true },
				cache: { importRefs: ['r/a:buildcache-trusted'], exportRef: 'r/a:buildcache-trusted' },
				metadataFile: '/t/m.json',
			}),
		).toEqual([
			'build',
			'--frontend',
			'dockerfile.v0',
			'--local',
			'context=/w',
			'--local',
			'dockerfile=/w/docker',
			'--opt',
			'filename=Dockerfile',
			'--opt',
			'target=runtime',
			'--opt',
			'platform=linux/arm64',
			'--opt',
			'build-arg:A=1',
			'--opt',
			'label:org.opencontainers.image.revision=abc',
			'--secret',
			'id=npmrc,src=/t/s/0',
			'--opt',
			'attest:provenance=mode=min',
			'--opt',
			'attest:sbom=',
			'--import-cache',
			'type=registry,ref=r/a:buildcache-trusted',
			'--export-cache',
			'type=registry,ref=r/a:buildcache-trusted,mode=max',
			'--output',
			'type=image,"name=r/a:1,r/a:latest",push=true',
			'--metadata-file',
			'/t/m.json',
		]);
	});
});

const DIGEST = `sha256:${'b'.repeat(64)}`;

/** A fake `buildctl`/`docker` that records its argv, env, DOCKER_CONFIG and secret files. */
function fakeTool(bin: string, name: string, log: string): void {
	writeFileSync(
		join(bin, name),
		`#!/bin/sh
{ for arg in "$@"; do echo "ARG $arg"; done
  echo "BUILDKIT_HOST=$BUILDKIT_HOST"
  echo "CONFIG $(cat "$DOCKER_CONFIG/config.json" 2>/dev/null)"
} >> "${log}"
prev=""
for arg in "$@"; do
  case "$prev" in --metadata-file) printf '{"containerimage.digest":"${DIGEST}"}' > "$arg" ;; esac
  case "$arg" in id=*,src=*) src="\${arg#*,src=}"; echo "SECRET \${arg%%,src=*} $(cat "$src")" >> "${log}" ;; esac
  prev="$arg"
done
case "$1" in image) echo '["ghcr.io/acme/api@${DIGEST}"]' ;; *) echo "building..." ;; esac
`,
		{ mode: 0o755 },
	);
}

function setup(claimPatch: Partial<PipelineJobClaim> = {}, tool: 'buildctl' | 'docker' = 'buildctl') {
	const dir = mkdtempSync(join(tmpdir(), 'skiff-build-image-'));
	dirs.push(dir);
	const workspace = join(dir, 'workspace');
	const bin = join(dir, 'bin');
	mkdirSync(workspace, { recursive: true });
	mkdirSync(bin);
	writeFileSync(join(workspace, 'Dockerfile'), 'FROM scratch\n');
	const log = join(dir, 'calls.log');
	fakeTool(bin, tool, log);
	const claim: PipelineJobClaim = { ...jobClaim({ steps: [] }), registry: { host: 'registry.test', namespace: 'registry.test/acme', push: true }, buildkit: true, ...claimPatch };
	const host = testHost({ claim, workspace, temp: join(dir, 'tmp'), env: { PATH: `${bin}:/usr/bin:/bin`, BUILDKIT_HOST: 'unix:///tmp/fake.sock' } });
	const calls = () => readFileSync(log, 'utf8');
	const args = () =>
		calls()
			.split('\n')
			.filter((line) => line.startsWith('ARG '))
			.map((line) => line.slice(4));
	return { host, calls, args, temp: join(dir, 'tmp') };
}

describe('skiff/build-image with BuildKit', () => {
	test('pushes to the platform registry as the job, with cache, attestations and secret mounts', async () => {
		const { host, calls, args, temp } = setup();
		const result = await runAction(
			'skiff/build-image',
			{ tags: 'registry/api:abc', secrets: 'npmrc=s3cr3t-npm', 'build-args': 'MODE=prod', platforms: 'native', target: 'runtime' },
			host,
		);
		expect(host.lines.join('\n')).not.toContain('s3cr3t-npm');
		expect(result).toEqual({
			outcome: 'success',
			outputs: { digest: DIGEST, image: `registry.test/acme/api@${DIGEST}`, tags: 'registry.test/acme/api:abc' },
		});
		const argv = args();
		expect(argv).toContain('type=registry,ref=registry.test/acme/api:buildcache-trusted,mode=max');
		expect(argv).toContain('type=registry,ref=registry.test/acme/api:buildcache-trusted');
		expect(argv).toContain('attest:provenance=mode=min');
		expect(argv).toContain('attest:sbom=');
		expect(argv).toContain('target=runtime');
		expect(argv).toContain('build-arg:MODE=prod');
		expect(argv).toContain('type=image,"name=registry.test/acme/api:abc",push=true');
		expect(argv.some((arg) => arg.startsWith('platform='))).toBe(false);
		const log = calls();
		expect(log).toContain('BUILDKIT_HOST=unix:///tmp/fake.sock');
		expect(log).toContain('SECRET id=npmrc s3cr3t-npm');
		const auth = Buffer.from('job.job_test1:job-token-123').toString('base64');
		expect(log).toContain(`CONFIG {"auths":{"registry.test":{"auth":"${auth}"}}}`);
		// Auth, secrets and metadata are gone after the step.
		expect(readdirSync(temp).filter((name) => name.startsWith('build-image-'))).toEqual([]);
	});

	test('untrusted runs never export cache and cannot push to the platform registry', async () => {
		const pr = { trust: 'untrusted' as const, checkout: { ref: 'refs/pull/7/merge', sha: 'a'.repeat(40) }, registry: { host: 'registry.test', namespace: 'registry.test/acme', push: false } };
		const refused = setup(pr);
		expect((await runAction('skiff/build-image', { tags: 'registry/api:pr' }, refused.host)).outcome).toBe('failure');
		expect(refused.host.lines.join('\n')).toContain('cannot push');

		const { host, args } = setup(pr);
		const result = await runAction('skiff/build-image', { tags: 'registry/api:pr', push: 'false' }, host);
		expect(result.outcome).toBe('success');
		expect(result.outputs.digest).toBe('');
		const argv = args();
		expect(argv.some((arg) => arg === '--export-cache')).toBe(false);
		expect(argv).toContain('type=registry,ref=registry.test/acme/api:buildcache-untrusted-refs-pull-7-merge');
		expect(argv).toContain('type=registry,ref=registry.test/acme/api:buildcache-trusted');
		expect(argv.some((arg) => arg.startsWith('attest:'))).toBe(false);
	});

	test('refuses a build arg that carries a secret value', async () => {
		const { host } = setup();
		const result = await runAction('skiff/build-image', { tags: 'registry/api:abc', secrets: 'token=hunter2-long', 'build-args': 'TOKEN=hunter2-long' }, host);
		expect(result.outcome).toBe('failure');
		expect(host.lines.join('\n')).toContain('must not contain secrets');
		expect(host.lines.join('\n')).not.toContain('hunter2-long');
	});

	test('BUILDKIT_HOST comes from the sidecar when the step env lacks it', () => {
		const env = builderEnv({ env: { PATH: '/usr/bin' }, claim: { ...jobClaim({ steps: [] }), buildkit: true } }, {});
		expect(env.BUILDKIT_HOST).toBe('unix:///skiff/buildkit/buildkitd.sock');
		expect(env.PATH).toBe('/usr/bin:/skiff/bin');
		expect(builderEnv({ env: { PATH: '/usr/bin' }, claim: jobClaim({ steps: [] }) }, {}).BUILDKIT_HOST).toBeUndefined();
	});
});

describe('skiff/build-image with docker (fallback)', () => {
	test('passes secrets as mounts and leaves attestations to the driver unless asked', async () => {
		const { host, args, calls } = setup({ buildkit: false }, 'docker');
		const result = await runAction('skiff/build-image', { tags: 'ghcr.io/acme/api:1', builder: 'docker', secrets: 'npmrc=abc123secret', username: 'me', password: 'ghp_x' }, host);
		expect(result.outcome).toBe('success');
		expect(result.outputs.image).toBe(`ghcr.io/acme/api@${DIGEST}`);
		const argv = args();
		expect(argv.slice(0, 1)).toEqual(['build']);
		expect(argv).toContain('push');
		expect(argv).toContain('ghcr.io/acme/api:1');
		expect(argv.some((arg) => arg.startsWith('--provenance') || arg.startsWith('--sbom'))).toBe(false);
		expect(calls()).toContain('SECRET id=npmrc abc123secret');
		expect(calls()).toContain(Buffer.from('me:ghp_x').toString('base64'));
	});
});

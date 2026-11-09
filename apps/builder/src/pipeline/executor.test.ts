import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig, type BuilderConfig } from '../config.ts';
import { PipelineExecutor, resolveStepCommand } from './executor.ts';
import { gitRepo } from './git-fixture.ts';
import { jobClaim, startFakeControlPlane, stepSpec, type FakeControlPlane } from './test-server.ts';

const root = mkdtempSync(join(tmpdir(), 'yoal-executor-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const origin = gitRepo(join(root, 'origin'));
const sha = origin.commit({ 'README.md': 'hello from the repo\n' }, 'initial');

let fake: FakeControlPlane;
beforeEach(() => {
	fake = startFakeControlPlane({ secrets: { TOKEN: 'top-secret' } });
});
afterEach(() => fake.stop());

function config(overrides: Partial<BuilderConfig> = {}): BuilderConfig {
	return {
		...loadConfig(
			{ YOAL_CONTROL_URL: fake.url, YOAL_NODE_TOKEN: 'node', YOAL_BUILD_DIR: join(root, 'build'), YOAL_BUILDER_SYSTEMD: 'false' },
			{ platform: 'darwin', isRoot: false, has: () => false, arch: 'arm64', exists: () => false },
		),
		...overrides,
	};
}

describe('resolveStepCommand', () => {
	test('explicit binary, compiled self, or the agent entry point from source', () => {
		expect(resolveStepCommand({ explicit: '/opt/x/yoal-step', isolation: 'container', main: '/src/main.ts', execPath: '/bun' })).toEqual([
			'/opt/x/yoal-step',
		]);
		expect(resolveStepCommand({ explicit: null, isolation: 'container', main: '/$bunfs/root/yoal-agent', execPath: '/opt/yoal/bin/yoal-agent' })).toEqual([
			'/opt/yoal/bin/yoal-agent',
		]);
		expect(resolveStepCommand({ explicit: null, isolation: 'sandbox', main: '/repo/x.ts', execPath: '/bun', agentMain: '/repo/apps/agent/src/main.ts' })).toEqual([
			'/bun',
			'/repo/apps/agent/src/main.ts',
		]);
		expect(() => resolveStepCommand({ explicit: null, isolation: 'container', main: '/repo/x.ts', execPath: '/bun' })).toThrow(ConfigError);
	});
});

describe.skipIf(isRoot)('PipelineExecutor (direct sandbox mode)', () => {
	test('clones the exact commit, runs the step runner through `yoal-agent pipeline-step`, and cleans up', async () => {
		const claim = jobClaim({
			cloneUrl: origin.dir,
			sha,
			token: fake.token,
			steps: [stepSpec({ run: 'cat README.md\necho "secret=${{ secrets.TOKEN }}"\ntest -z "${YOAL_JOB_TOKEN:-}" && echo no-token-in-env' })],
		});
		await new PipelineExecutor(config(), () => undefined).run(claim);
		expect(fake.completes).toHaveLength(1);
		expect(fake.completes[0]?.conclusion).toBe('success');
		expect(fake.stepLog(-1).join('\n')).toContain(`Checking out acme/app at ${sha}`);
		const log = fake.stepLog(0);
		expect(log).toContain('hello from the repo');
		expect(log).toContain('secret=***');
		expect(log).toContain('no-token-in-env');
		expect(existsSync(join(root, 'build', 'pipelines', claim.jobId))).toBe(false);
	}, 60_000);

	test('completes the job itself when the step runner dies without completing', async () => {
		const claim = jobClaim({ cloneUrl: origin.dir, sha, token: fake.token, steps: [stepSpec({ run: 'true' })] });
		await new PipelineExecutor(config({ pipelineStepBinary: '/usr/bin/false' }), () => undefined).run(claim);
		expect(fake.completes).toEqual([
			{ conclusion: 'failure', outputs: {}, error: 'The step runner exited with code 1 without completing the job.' },
		]);
	}, 30_000);

	test('sandbox isolation refuses container: and services:', async () => {
		const claim = jobClaim({
			cloneUrl: origin.dir,
			sha,
			token: fake.token,
			steps: [stepSpec({ run: 'true' })],
			job: { services: { redis: { image: 'redis:7', env: {}, ports: [], healthCmd: null } } },
		});
		await new PipelineExecutor(config(), () => undefined).run(claim);
		expect(fake.completes[0]?.conclusion).toBe('failure');
		expect(fake.completes[0]?.error).toContain('need container isolation');
	});

	test('a bad checkout fails the job with the git error', async () => {
		const claim = jobClaim({ cloneUrl: origin.dir, sha: 'f'.repeat(40), token: fake.token, steps: [stepSpec({ run: 'true' })] });
		await new PipelineExecutor(config(), () => undefined).run(claim);
		expect(fake.completes[0]?.conclusion).toBe('failure');
		expect(fake.completes[0]?.error).toMatch(/git|Commit/);
	}, 30_000);
});

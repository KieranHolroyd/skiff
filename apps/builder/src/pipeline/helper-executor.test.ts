import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type BuilderConfig } from '../config.ts';
import { PipelineExecutor } from './executor.ts';
import { gitRepo } from './git-fixture.ts';
import {
	PipelineHelperClient,
	readK8sLog,
	type HelperPipelineCapabilities,
	type HelperPipelineStart,
	type HelperPipelineStatus,
	type PipelineHelper,
} from './helper-client.ts';
import { probeIsolation } from './loop.ts';
import { jobClaim, startFakeControlPlane, stepSpec, type FakeControlPlane } from './test-server.ts';

const root = mkdtempSync(join(tmpdir(), 'skiff-helper-executor-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const origin = gitRepo(join(root, 'origin'));
const sha = origin.commit({ 'README.md': 'hello\n' }, 'initial');
const buildDir = join(root, 'build');

let fake: FakeControlPlane;
beforeEach(() => {
	fake = startFakeControlPlane({ secrets: { DB_PASSWORD: 'hunter2-secret' } });
});
afterEach(() => fake.stop());

function config(overrides: Partial<BuilderConfig> = {}): BuilderConfig {
	return {
		...loadConfig(
			{ SKIFF_CONTROL_URL: fake.url, SKIFF_NODE_TOKEN: 'node', SKIFF_BUILD_DIR: buildDir, SKIFF_BUILDER_SYSTEMD: 'false' },
			{ platform: 'darwin', isRoot: false, has: () => false, arch: 'arm64', exists: () => false },
		),
		pipelineIsolation: 'container',
		...overrides,
	};
}

const caps: HelperPipelineCapabilities = {
	podman: '5.4.2',
	runtimes: ['runc', 'runsc'],
	userns: true,
	fuse: true,
	kvm: false,
	stepBinary: true,
	buildsRoot: buildDir,
	buildkit: { version: '0.34.2', image: 'docker.io/moby/buildkit@sha256:x' },
};

/** A scripted helper: each status call returns the next state; `onStart` can write runner.log. */
class FakeHelper implements PipelineHelper {
	starts: HelperPipelineStart[] = [];
	stops: Array<{ jobId: string; force: boolean }> = [];
	cleanups: string[] = [];
	private index = 0;
	constructor(
		private readonly script: Array<Partial<HelperPipelineStatus>>,
		private readonly onStart: (request: HelperPipelineStart) => void = () => undefined,
	) {}
	async capabilities() {
		return caps;
	}
	async start(request: HelperPipelineStart) {
		this.starts.push(request);
		this.onStart(request);
		return this.make({ state: 'starting' }, request.jobId);
	}
	async status(jobId: string) {
		const next = this.script[Math.min(this.index++, this.script.length - 1)]!;
		return this.make(next, jobId);
	}
	async stop(jobId: string, force = false) {
		this.stops.push({ jobId, force });
	}
	async cleanup(jobId: string) {
		this.cleanups.push(jobId);
	}
	async list() {
		return ['job_old'];
	}
	private make(partial: Partial<HelperPipelineStatus>, jobId: string): HelperPipelineStatus {
		return { jobId, state: 'running', exitCode: null, oomKilled: false, error: null, events: [], ...partial };
	}
}

describe('PipelineExecutor through skiff-helper', () => {
	test('starts the job through the helper verbs, follows it, tails runner.log and cleans up', async () => {
		const lines: string[] = [];
		const claim = {
			...jobClaim({
				cloneUrl: origin.dir,
				sha,
				token: fake.token,
				steps: [stepSpec({ run: 'true' })],
				job: {
					runsOn: ['linux', 'oci-build'],
					services: { postgres: { image: 'postgres:17', env: { POSTGRES_PASSWORD: '${{ secrets.DB_PASSWORD }}' }, ports: [], healthCmd: 'pg_isready' } },
				},
			}),
			runtime: 'runsc' as const,
			buildkit: true,
			buildkitCacheScope: 'repo_1:trusted',
		};
		const helper = new FakeHelper(
			[
				{ state: 'starting', events: ['Pulled docker.io/library/node:24-bookworm in 1.0s'] },
				{ state: 'running', events: ['Pulled docker.io/library/node:24-bookworm in 1.0s', 'Service postgres is healthy'] },
				{ state: 'exited', exitCode: 0 },
			],
			(request) => {
				const log = join(buildDir, 'pipelines', request.jobId, 'runner.log');
				writeFileSync(log, '2026-11-08T00:00:00.1Z stdout F step runner up\n2026-11-08T00:00:00.2Z stderr P half \n');
				appendFileSync(log, '2026-11-08T00:00:00.3Z stderr F line with hunter2-secret\n');
			},
		);
		await new PipelineExecutor(config(), (line) => lines.push(line), { helper }).run(claim);

		expect(helper.starts).toHaveLength(1);
		const start = helper.starts[0]!;
		expect(start).toMatchObject({
			jobId: 'job_test1',
			image: 'docker.io/library/node:24-bookworm',
			memoryMb: 2048,
			cpus: 2,
			runtime: 'runsc',
			profile: 'oci-build',
			buildkit: true,
			buildkitCacheScope: 'repo_1:trusted',
		});
		expect(start.env).toContain(`SKIFF_JOB_TOKEN=${fake.token}`);
		expect(start.env.some((entry) => entry.startsWith('SKIFF_CONTROL_URL='))).toBe(true);
		expect(start.services).toEqual([
			{ name: 'postgres', image: 'docker.io/library/postgres:17', env: ['POSTGRES_PASSWORD=hunter2-secret'], healthCmd: 'pg_isready' },
		]);
		// The step runner completes a successful job itself; the executor only reports failures.
		expect(fake.completes).toHaveLength(0);
		const system = fake.stepLog(-1).join('\n');
		expect(system).toContain('Pulled docker.io/library/node:24-bookworm in 1.0s');
		expect(system).toContain('Service postgres is healthy');
		expect(system).toContain('(runtime runsc)');
		expect(lines).toContain('job_test1 | step runner up');
		expect(lines).toContain('job_test1 | half line with ***');
		expect(helper.cleanups).toEqual(['job_test1']);
		expect(existsSync(join(buildDir, 'pipelines', 'job_test1'))).toBe(false);
	}, 30_000);

	test('a job that could not start fails with the helper reason, masked', async () => {
		const claim = jobClaim({
			cloneUrl: origin.dir,
			sha,
			token: fake.token,
			steps: [stepSpec({ run: 'true' })],
			job: { services: { db: { image: 'postgres:17', env: { P: '${{ secrets.DB_PASSWORD }}' }, ports: [], healthCmd: null } } },
		});
		const helper = new FakeHelper([{ state: 'failed', error: 'Service db did not become ready; last output:\nbad password hunter2-secret' }]);
		await new PipelineExecutor(config(), () => undefined, { helper }).run(claim);
		expect(fake.completes).toHaveLength(1);
		expect(fake.completes[0]?.conclusion).toBe('failure');
		expect(fake.completes[0]?.error).toContain('Service db did not become ready');
		expect(fake.completes[0]?.error).not.toContain('hunter2-secret');
		expect(helper.cleanups).toEqual(['job_test1']);
	}, 30_000);

	test('a non-zero exit without completion fails the job; OOM is called out', async () => {
		const claim = jobClaim({ cloneUrl: origin.dir, sha, token: fake.token, steps: [stepSpec({ run: 'true' })] });
		const helper = new FakeHelper([{ state: 'exited', exitCode: 137, oomKilled: true }]);
		await new PipelineExecutor(config(), () => undefined, { helper }).run(claim);
		expect(helper.starts[0]?.runtime).toBe('runc');
		expect(helper.starts[0]?.profile).toBe('default');
		expect(helper.starts[0]?.buildkit).toBe(false);
		expect(fake.completes[0]).toEqual({
			conclusion: 'failure',
			outputs: {},
			error: 'The step runner exited with code 137 without completing the job.',
		});
		expect(fake.stepLog(-1).join('\n')).toContain('ran out of memory');
	}, 30_000);

	test('orphans are reaped through the helper', async () => {
		const helper = new FakeHelper([]);
		await new PipelineExecutor(config(), () => undefined, { helper }).reapOrphans();
		expect(helper.cleanups).toEqual(['job_old']);
	});

	test('probeIsolation: auto becomes container with the helper runtimes, sandbox without a helper', async () => {
		const auto = config({ pipelineIsolation: 'sandbox' });
		expect(await probeIsolation(auto, new FakeHelper([]))).toMatchObject({ isolation: 'container', runtimes: ['runc', 'runsc'] });
		const down: PipelineHelper = { ...new FakeHelper([]), capabilities: async () => Promise.reject(new Error('ENOENT')) } as unknown as PipelineHelper;
		const choice = await probeIsolation(auto, down);
		expect(choice.isolation).toBe('sandbox');
		expect(choice.reason).toContain('ENOENT');
	});
});

describe('PipelineHelperClient', () => {
	test('speaks the verbs over the unix socket and surfaces helper errors', async () => {
		const socket = join(root, 'helper.sock');
		const seen: string[] = [];
		const server = Bun.serve({
			unix: socket,
			async fetch(request) {
				const url = new URL(request.url);
				seen.push(`${request.method} ${url.pathname} ${request.method === 'POST' ? await request.text() : ''}`.trim());
				if (url.pathname === '/v1/pipeline/capabilities') return Response.json({ ok: true, capabilities: caps });
				if (url.pathname === '/v1/pipeline/jobs') return Response.json({ ok: true, jobs: ['a'] });
				if (url.pathname === '/v1/pipeline/jobs/start') return Response.json({ error: 'memoryMb must be an integer' }, { status: 400 });
				if (url.pathname === '/v1/pipeline/jobs/j1') return Response.json({ ok: true, job: { jobId: 'j1', state: 'running', exitCode: null, oomKilled: false, error: null, events: [] } });
				return Response.json({ ok: true });
			},
		});
		try {
			const client = new PipelineHelperClient(socket);
			expect((await client.capabilities()).runtimes).toEqual(['runc', 'runsc']);
			expect(await client.list()).toEqual(['a']);
			expect((await client.status('j1')).state).toBe('running');
			await client.stop('j1', true);
			await client.cleanup('j1');
			await expect(client.start({} as HelperPipelineStart)).rejects.toThrow(/400 memoryMb must be an integer/);
			expect(seen).toContain('POST /v1/pipeline/jobs/j1/stop {"force":true}');
			expect(seen).toContain('POST /v1/pipeline/jobs/j1/cleanup {}');
			await expect(new PipelineHelperClient(join(root, 'missing.sock')).capabilities()).rejects.toThrow(/not reachable/);
		} finally {
			server.stop(true);
		}
	});

	test('readK8sLog joins partial records, keeps an offset and survives truncation', async () => {
		const path = join(root, 'k8s.log');
		expect(await readK8sLog(path, 0)).toEqual({ lines: [], offset: 0 });
		writeFileSync(path, '2026-01-01T00:00:00Z stdout F one\n2026-01-01T00:00:01Z stdout P tw');
		const first = await readK8sLog(path, 0);
		expect(first.lines).toEqual(['one']);
		writeFileSync(path, '2026-01-01T00:00:00Z stdout F one\n2026-01-01T00:00:01Z stdout P tw\n2026-01-01T00:00:02Z stderr F o\n');
		const second = await readK8sLog(path, first.offset);
		expect(second.lines).toEqual(['two']);
		writeFileSync(path, '2026-01-01T00:00:03Z stdout F after rotate\n');
		expect((await readK8sLog(path, second.offset)).lines).toEqual(['after rotate']);
	});
});

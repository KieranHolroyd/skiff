import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	BUILDKIT,
	BUILDKIT_HOST,
	buildkitCacheDir,
	cacheScopeDirName,
	detectPipelineCapabilities,
	jobEnv,
	jobPath,
	parseInspectState,
	parsePipelineJobStart,
	pipelineJobPaths,
	PipelineJobDriver,
	renderBuildkitArgs,
	renderEnvFile,
	renderJobContainerArgs,
	renderServiceArgs,
	resolveBuildsRoot,
	routePipelineRequest,
	type PipelineJobApi,
} from './pipeline-jobs.ts';
import type { CommandRunner, RunResult } from './systemd.ts';
import { ValidationError } from './validate.ts';
import { createHandler, type HelperRuntime } from './server.ts';

const root = mkdtempSync(join(tmpdir(), 'skiff-pipeline-jobs-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const base = { jobId: 'pj_abc123', image: 'node:24-bookworm', memoryMb: 2048, cpus: 2, env: ['SKIFF_JOB_TOKEN=pjt_secret', 'SKIFF_CONTROL_URL=https://c.test'] };

describe('parsePipelineJobStart', () => {
	test('accepts a full request, qualifies images and defaults runtime/profile', () => {
		const parsed = parsePipelineJobStart({
			...base,
			services: [{ name: 'postgres', image: 'postgres:17', env: ['POSTGRES_PASSWORD=pw'], healthCmd: 'pg_isready -U postgres' }],
			buildkit: true,
			buildkitCacheScope: 'repo_1:trusted:main',
		});
		expect(parsed.image).toBe('docker.io/library/node:24-bookworm');
		expect(parsed.runtime).toBe('runc');
		expect(parsed.profile).toBe('default');
		expect(parsed.env).toEqual([
			['SKIFF_JOB_TOKEN', 'pjt_secret'],
			['SKIFF_CONTROL_URL', 'https://c.test'],
		]);
		expect(parsed.services[0]).toEqual({
			name: 'postgres',
			image: 'docker.io/library/postgres:17',
			env: [['POSTGRES_PASSWORD', 'pw']],
			healthCmd: 'pg_isready -U postgres',
			aliases: ['postgres'],
		});
		expect(parsed.buildkitCacheScope).toBe('repo_1:trusted:main');
		expect(parsePipelineJobStart({ ...base, buildkitCacheScope: 'x' }).buildkitCacheScope).toBeNull();
		expect(parsePipelineJobStart({ ...base, image: 'ghcr.io/acme/ci:1' }).image).toBe('ghcr.io/acme/ci:1');
	});

	test('refuses anything outside the fixed shape', () => {
		const bad: unknown[] = [
			{ ...base, jobId: '../etc' },
			{ ...base, jobId: '-x' },
			{ ...base, extra: 1 },
			{ ...base, image: 'UPPER/case' },
			{ ...base, image: 'node; rm -rf /' },
			{ ...base, memoryMb: 1 },
			{ ...base, memoryMb: 1.5 },
			{ ...base, cpus: 0 },
			{ ...base, runtime: 'docker' },
			{ ...base, profile: 'privileged' },
			{ ...base, env: ['PATH=/evil'] },
			{ ...base, env: ['HOME=/root'] },
			{ ...base, env: ['A=1', 'A=2'] },
			{ ...base, env: ['A=line\nB=2'] },
			{ ...base, env: ['=x'] },
			{ ...base, env: ['1A=x'] },
			{ ...base, env: [`BIG=${'x'.repeat(40_000)}`] },
			{ ...base, env: { A: '1' } },
			{ ...base, services: [{ name: 'Bad_Name', image: 'redis' }] },
			{ ...base, services: [{ name: 'redis', image: 'redis', volumes: ['/:/host'] }] },
			{ ...base, services: [{ name: 'redis', image: 'redis', healthCmd: 'a\nb' }] },
			{ ...base, services: [{ name: 'a', image: 'redis' }, { name: 'a', image: 'redis' }] },
			{ ...base, services: [{ name: 'a', image: 'redis', aliases: ['db'] }, { name: 'b', image: 'redis', aliases: ['db'] }] },
			{ ...base, services: Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, image: 'redis' })) },
			{ ...base, buildkit: 'yes' },
			{ ...base, buildkit: true, buildkitCacheScope: 'a\u0000b' },
		];
		for (const value of bad) expect(() => parsePipelineJobStart(value)).toThrow(ValidationError);
	});
});

describe('paths', () => {
	test('every host path derives from the builds root, runtime dir and job id', () => {
		const paths = pipelineJobPaths('/var/lib/skiff-builder', '/run/skiff-workloads', 'pj_1');
		expect(paths).toEqual({
			jobRoot: '/var/lib/skiff-builder/pipelines/pj_1',
			workspace: '/var/lib/skiff-builder/pipelines/pj_1/workspace',
			home: '/var/lib/skiff-builder/pipelines/pj_1/home',
			tmp: '/var/lib/skiff-builder/pipelines/pj_1/tmp',
			meta: '/var/lib/skiff-builder/pipelines/pj_1/meta',
			runnerLog: '/var/lib/skiff-builder/pipelines/pj_1/runner.log',
			runtime: '/run/skiff-workloads/pipeline-jobs/pj_1',
			envFile: '/run/skiff-workloads/pipeline-jobs/pj_1/job.env',
			buildkitSocketDir: '/run/skiff-workloads/pipeline-jobs/pj_1/buildkit',
		});
		expect(() => pipelineJobPaths('/b', '/r', '../x')).toThrow(ValidationError);
	});

	test('cache scopes become one safe directory name that never collides', () => {
		expect(cacheScopeDirName('repo-1.trusted')).toBe('repo-1.trusted');
		const lossy = cacheScopeDirName('repo_1:trusted:main');
		expect(lossy).toMatch(/^repo_1-trusted-main-[a-f0-9]{16}$/);
		expect(cacheScopeDirName('repo_1-trusted-main')).toBe('repo_1-trusted-main');
		expect(cacheScopeDirName('Repo')).not.toBe(cacheScopeDirName('repo'));
		expect(cacheScopeDirName('a:b')).not.toBe(cacheScopeDirName('a/b'));
		for (const scope of ['../..', '.hidden', '/', 'x'.repeat(500), 'ü']) {
			const name = cacheScopeDirName(scope);
			expect(name).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
			expect(name.length).toBeLessThanOrEqual(64);
		}
		expect(buildkitCacheDir('/b', 'main', 'pj_1')).toBe('/b/buildkit-cache/main');
		expect(buildkitCacheDir('/b', null, 'pj_1')).toBe('/b/buildkit-cache/job-pj_1');
	});

	test('the builds root follows the Builder storage drop-in (D48)', async () => {
		const unitDir = join(root, 'units');
		expect(await resolveBuildsRoot({ unitDir })).toBe('/var/lib/skiff-builder');
		mkdirSync(join(unitDir, 'skiff-builder.service.d'), { recursive: true });
		writeFileSync(
			join(unitDir, 'skiff-builder.service.d', 'skiff-storage.conf'),
			'[Service]\nEnvironment=SKIFF_BUILD_DIR=/mnt/pool/builder\nEnvironment=HOME=/mnt/pool/builder\n',
		);
		expect(await resolveBuildsRoot({ unitDir })).toBe('/mnt/pool/builder');
		expect(await resolveBuildsRoot({ unitDir, override: '/srv/builds' })).toBe('/srv/builds');
	});
});

describe('rendering', () => {
	const paths = pipelineJobPaths('/var/lib/skiff-builder', '/run/skiff-workloads', 'pj_1');
	const request = parsePipelineJobStart({ ...base, jobId: 'pj_1' });

	test('the default job container: no capabilities, userns=auto, env only through --env-file', () => {
		const argv = renderJobContainerArgs({
			podmanPath: '/usr/bin/podman',
			request,
			paths,
			network: null,
			stepBinary: '/var/lib/skiff-builder/tools/skiff-step-1-2',
			buildctl: null,
			fuse: true,
			apparmorProfile: null,
		});
		expect(argv).toEqual([
			'/usr/bin/podman',
			'run',
			'-d',
			'--name=skiff-job-pj_1',
			'--label=skiff.pipeline-job=pj_1',
			'--init',
			'--pull=never',
			'--userns=auto:size=65536',
			'--cap-drop=all',
			'--security-opt=no-new-privileges',
			'--pids-limit=4096',
			'--memory=2048m',
			'--memory-swap=2048m',
			'--cpus=2',
			'--log-driver=k8s-file',
			'--log-opt=path=/var/lib/skiff-builder/pipelines/pj_1/runner.log',
			'--log-opt=max-size=10mb',
			'--env-file=/run/skiff-workloads/pipeline-jobs/pj_1/job.env',
			'--volume=/var/lib/skiff-builder/pipelines/pj_1/workspace:/workspace:Z,U',
			'--volume=/var/lib/skiff-builder/pipelines/pj_1/meta:/skiff/meta:ro,Z,U',
			'--volume=/var/lib/skiff-builder/pipelines/pj_1/home:/skiff/home:Z,U',
			'--volume=/var/lib/skiff-builder/pipelines/pj_1/tmp:/skiff/tmp:Z,U',
			'--volume=/var/lib/skiff-builder/tools/skiff-step-1-2:/skiff/bin/skiff-step:ro,z',
			'--workdir=/workspace',
			'--entrypoint=/skiff/bin/skiff-step',
			'docker.io/library/node:24-bookworm',
			'pipeline-step',
			'/skiff/meta/job.json',
		]);
		expect(argv.join(' ')).not.toContain('pjt_secret');
	});

	test('oci-build keeps default capabilities with /dev/fuse; runsc and BuildKit add their flags', () => {
		const argv = renderJobContainerArgs({
			podmanPath: '/usr/bin/podman',
			request: { ...request, profile: 'oci-build', runtime: 'runsc', buildkit: true },
			paths,
			network: 'skiff-job-pj_1',
			stepBinary: '/t/skiff-step',
			buildctl: '/t/buildctl-0.34.2',
			fuse: true,
			apparmorProfile: 'unconfined',
		});
		expect(argv).toContain('--runtime=runsc');
		expect(argv).toContain('--security-opt=label=disable');
		expect(argv).toContain('--device=/dev/fuse');
		expect(argv).not.toContain('--cap-drop=all');
		expect(argv).toContain('--security-opt=no-new-privileges');
		expect(argv).toContain('--security-opt=apparmor=unconfined');
		expect(argv).toContain('--network=skiff-job-pj_1');
		expect(argv).toContain('--volume=/t/buildctl-0.34.2:/skiff/bin/buildctl:ro,z');
		expect(argv).toContain('--volume=/run/skiff-workloads/pipeline-jobs/pj_1/buildkit:/skiff/buildkit:ro,z');
		const noFuse = renderJobContainerArgs({
			podmanPath: 'podman',
			request: { ...request, profile: 'oci-build' },
			paths,
			network: null,
			stepBinary: '/t/s',
			buildctl: null,
			fuse: false,
			apparmorProfile: null,
		});
		expect(noFuse.some((arg) => arg.includes('fuse') || arg.startsWith('--runtime'))).toBe(false);
	});

	test('services: own env file, aliases on the job network, health check run on demand', () => {
		const withService = parsePipelineJobStart({
			...base,
			jobId: 'pj_1',
			services: [{ name: 'postgres', image: 'postgres:17', env: ['POSTGRES_PASSWORD=pw'], healthCmd: 'pg_isready', aliases: ['db', 'postgres'] }],
		});
		const argv = renderServiceArgs({
			podmanPath: 'podman',
			request: withService,
			service: withService.services[0]!,
			paths,
			network: 'skiff-job-pj_1',
			apparmorProfile: null,
		});
		expect(argv).toEqual([
			'podman',
			'run',
			'-d',
			'--name=skiff-job-pj_1-svc-postgres',
			'--label=skiff.pipeline-job=pj_1',
			'--pull=never',
			'--userns=auto:size=65536',
			'--security-opt=no-new-privileges',
			'--pids-limit=4096',
			'--memory=2048m',
			'--network=skiff-job-pj_1',
			'--network-alias=db',
			'--network-alias=postgres',
			'--log-driver=k8s-file',
			'--log-opt=path=/run/skiff-workloads/pipeline-jobs/pj_1/svc-postgres.log',
			'--log-opt=max-size=5mb',
			'--env-file=/run/skiff-workloads/pipeline-jobs/pj_1/svc-postgres.env',
			'--health-cmd=pg_isready',
			'--health-interval=disable',
			'docker.io/library/postgres:17',
		]);
		expect(argv.join(' ')).not.toContain('pw');
	});

	test('BuildKit: pinned image, WS1 profile, never no-process-sandbox', () => {
		const argv = renderBuildkitArgs({ podmanPath: 'podman', request, paths, cacheDir: '/var/lib/skiff-builder/buildkit-cache/main', fuse: false });
		expect(argv).toEqual([
			'podman',
			'run',
			'-d',
			'--name=skiff-job-pj_1-buildkit',
			'--label=skiff.pipeline-job=pj_1',
			'--pull=never',
			'--userns=auto:size=165536',
			'--security-opt=seccomp=unconfined',
			'--security-opt=apparmor=unconfined',
			'--security-opt=unmask=ALL',
			'--security-opt=label=disable',
			'--pids-limit=8192',
			'--memory=2048m',
			'--cpus=2',
			'--log-driver=k8s-file',
			'--log-opt=path=/run/skiff-workloads/pipeline-jobs/pj_1/buildkit.log',
			'--log-opt=max-size=5mb',
			'--volume=/var/lib/skiff-builder/buildkit-cache/main:/home/user/.local/share/buildkit:Z,U',
			'--volume=/run/skiff-workloads/pipeline-jobs/pj_1/buildkit:/skiff/buildkit:z,U',
			BUILDKIT.image,
			'--addr=unix:///skiff/buildkit/buildkitd.sock',
		]);
		expect(BUILDKIT.image).toMatch(/@sha256:[a-f0-9]{64}$/);
		expect(argv.join(' ')).not.toContain('no-process-sandbox');
		expect(argv).not.toContain('--security-opt=no-new-privileges');
	});

	test('env file and the helper-fixed variables', () => {
		expect(renderEnvFile([])).toBe('');
		expect(renderEnvFile([['A', '1'], ['B', 'x=y z']])).toBe('A=1\nB=x=y z\n');
		expect(jobPath(['HOME=/root', 'PATH=/usr/local/go/bin:/usr/bin'])).toBe('/skiff/bin:/usr/local/go/bin:/usr/bin');
		expect(jobPath(null)).toBe('/skiff/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
		const env = jobEnv({ ...request, buildkit: true }, '/skiff/bin:/usr/bin');
		expect(env.slice(0, 2)).toEqual(request.env);
		expect(env).toContainEqual(['BUILDKIT_HOST', BUILDKIT_HOST]);
		expect(env).toContainEqual(['HOME', '/skiff/home']);
		expect(jobEnv(request, '/p').some(([name]) => name === 'BUILDKIT_HOST')).toBe(false);
	});

	test('inspect states', () => {
		expect(parseInspectState('running|0|false')).toEqual({ state: 'running', exitCode: null, oomKilled: false });
		expect(parseInspectState('exited|3|false\n')).toEqual({ state: 'exited', exitCode: 3, oomKilled: false });
		expect(parseInspectState('exited|137|true')).toEqual({ state: 'exited', exitCode: 137, oomKilled: true });
		expect(parseInspectState('created|0|false')?.state).toBe('running');
		expect(parseInspectState('')).toBeNull();
	});
});

describe('detectPipelineCapabilities', () => {
	const probe = (files: string[], podman: RunResult | null = { code: 0, stdout: '5.4.2\n', stderr: '' }, subids = true) => ({
		run: async () => {
			if (!podman) throw new Error('ENOENT');
			return podman;
		},
		exists: async (path: string) => files.includes(path),
		ensureSubids: async () => {
			if (!subids) throw new Error('overlap');
			return false;
		},
	});
	const input = (p: ReturnType<typeof probe>) => ({ probe: p, podmanPath: '/usr/bin/podman', stepBinary: '/opt/skiff/agent', buildsRoot: '/b' });

	test('runc always, runsc when installed where Podman looks, kata only with /dev/kvm', async () => {
		expect(await detectPipelineCapabilities(input(probe(['/opt/skiff/agent', '/dev/fuse'])))).toEqual({
			podman: '5.4.2',
			runtimes: ['runc'],
			userns: true,
			fuse: true,
			kvm: false,
			stepBinary: true,
			buildsRoot: '/b',
			buildkit: { version: BUILDKIT.version, image: BUILDKIT.image },
		});
		expect((await detectPipelineCapabilities(input(probe(['/usr/local/bin/runsc', '/usr/bin/kata-runtime'])))).runtimes).toEqual(['runc', 'runsc']);
		expect((await detectPipelineCapabilities(input(probe(['/dev/kvm', '/usr/bin/kata-runtime'])))).runtimes).toEqual(['runc', 'kata']);
		expect((await detectPipelineCapabilities(input(probe(['/dev/kvm'])))).runtimes).toEqual(['runc']);
	});

	test('no Podman means no runtimes; a subuid overlap means no userns', async () => {
		const none = await detectPipelineCapabilities(input(probe(['/usr/bin/runsc'], null)));
		expect(none.podman).toBeNull();
		expect(none.runtimes).toEqual([]);
		expect((await detectPipelineCapabilities(input(probe([], { code: 125, stdout: '', stderr: 'boom' })))).podman).toBeNull();
		expect((await detectPipelineCapabilities(input(probe([], undefined, false)))).userns).toBe(false);
	});
});

/** A scripted podman: records argv, answers by the first argument after the binary. */
function fakeRunner(options: { inspect?: () => string; health?: () => number; failRun?: (argv: string[]) => string | null } = {}) {
	const calls: string[][] = [];
	const runner: CommandRunner = {
		async run(argv) {
			calls.push(argv);
			const [, verb, sub] = argv;
			const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
			if (verb === 'version') return ok('5.4.2\n');
			if (verb === 'run') {
				const failure = options.failRun?.(argv);
				return failure ? { code: 125, stdout: '', stderr: failure } : ok('cid\n');
			}
			if (verb === 'healthcheck') return { code: options.health?.() ?? 0, stdout: '', stderr: '' };
			if (verb === 'container' && sub === 'inspect') {
				const format = argv[4];
				if (format === '{{.State.Running}}') return ok('true\n');
				const text = options.inspect?.() ?? '';
				return text ? ok(text) : { code: 125, stdout: '', stderr: 'no such container' };
			}
			if (verb === 'image' && sub === 'inspect') return ok('["PATH=/usr/local/bin:/usr/bin"]\n');
			if (verb === 'logs') return ok('FATAL: boom\n');
			return ok();
		},
	};
	return { runner, calls };
}

function jobDir(buildsRoot: string, jobId: string): void {
	for (const sub of ['workspace', 'home', 'tmp', 'meta']) mkdirSync(join(buildsRoot, 'pipelines', jobId, sub), { recursive: true, mode: 0o700 });
}

async function settle(driver: PipelineJobDriver, jobId: string, until: (state: string) => boolean) {
	for (let i = 0; i < 200; i++) {
		const status = await driver.status(jobId);
		if (until(status.state)) return status;
		await Bun.sleep(5);
	}
	throw new Error('did not settle');
}

describe('PipelineJobDriver', () => {
	const buildsRoot = join(root, 'builds');
	const runtimeDir = join(root, 'run');
	const stepBinary = join(root, 'skiff-agent');
	writeFileSync(stepBinary, '#!/bin/sh\n', { mode: 0o755 });
	const subidFiles = { subuid: join(root, 'subuid'), subgid: join(root, 'subgid') };

	function driver(fake: ReturnType<typeof fakeRunner>, extra: { exists?: (path: string) => Promise<boolean> } = {}) {
		return new PipelineJobDriver({
			runner: fake.runner,
			podmanPath: 'podman',
			runtimeDir,
			buildsRoot: async () => buildsRoot,
			stepBinary,
			subidFiles,
			sleep: async () => undefined,
			...extra,
		});
	}

	test('start writes 0400 env files, launches in the background and reports the container state', async () => {
		let inspect = '';
		const fake = fakeRunner({ inspect: () => inspect });
		const d = driver(fake);
		jobDir(buildsRoot, 'pj_run');
		const request = parsePipelineJobStart({
			...base,
			jobId: 'pj_run',
			services: [{ name: 'postgres', image: 'postgres:17', env: ['POSTGRES_PASSWORD=pw'], healthCmd: 'pg_isready' }],
		});
		const first = await d.start(request);
		expect(first.state).toBe('starting');
		inspect = 'running|0|false';
		const paths = pipelineJobPaths(buildsRoot, runtimeDir, 'pj_run');
		const started = await settle(d, 'pj_run', (state) => state !== 'starting');
		expect(started.error).toBeNull();
		expect(started.state).toBe('running');
		expect(started.events).toContain('Service postgres is healthy');

		expect(statSync(paths.envFile).mode & 0o777).toBe(0o400);
		expect(readFileSync(paths.envFile, 'utf8')).toBe(
			'SKIFF_JOB_TOKEN=pjt_secret\nSKIFF_CONTROL_URL=https://c.test\nHOME=/skiff/home\nPATH=/skiff/bin:/usr/local/bin:/usr/bin\n' +
				'SKIFF_PIPELINE_WORKSPACE=/workspace\nSKIFF_PIPELINE_TEMP=/skiff/tmp\n',
		);
		expect(readFileSync(join(paths.runtime, 'svc-postgres.env'), 'utf8')).toBe('POSTGRES_PASSWORD=pw\n');
		expect(readFileSync(subidFiles.subuid, 'utf8')).toContain('containers:');
		for (const argv of fake.calls) expect(argv.join(' ')).not.toMatch(/pjt_secret|POSTGRES_PASSWORD=pw/);
		const verbs = fake.calls.map((argv) => argv.slice(1, 3).join(' '));
		expect(verbs.indexOf('network create')).toBeLessThan(verbs.findIndex((v) => v.startsWith('run')));
		const jobRun = fake.calls.find((argv) => argv[1] === 'run' && argv.includes('--name=skiff-job-pj_run'))!;
		expect(jobRun).toContain('--network=skiff-job-pj_run');
		expect(jobRun.find((arg) => arg.includes('/skiff/bin/skiff-step'))).toMatch(/\/tools\/skiff-step-\d+-\d+:\/skiff\/bin\/skiff-step:ro,z$/);
		// Idempotent while it exists.
		expect((await d.start(request)).state).toBe('running');

		inspect = 'exited|3|false';
		expect(await d.status('pj_run')).toMatchObject({ state: 'exited', exitCode: 3 });

		await d.stop('pj_run');
		await d.stop('pj_run', { force: true });
		expect(fake.calls.filter((argv) => argv[1] === 'kill').map((argv) => argv[2])).toEqual(['--signal=SIGTERM', '--signal=SIGKILL']);

		inspect = '';
		await d.cleanup('pj_run');
		expect(existsSync(paths.runtime)).toBe(false);
		expect(existsSync(paths.workspace)).toBe(true);
		expect(fake.calls.some((argv) => argv[1] === 'network' && argv[2] === 'rm' && argv.includes('skiff-job-pj_run'))).toBe(true);
		expect(fake.calls.some((argv) => argv[1] === 'rm' && argv.includes('skiff-job-pj_run'))).toBe(true);
		expect((await d.status('pj_run')).state).toBe('not-found');
	});

	test('a service that never becomes healthy fails the start with its last output', async () => {
		const fake = fakeRunner({ health: () => 1 });
		jobDir(buildsRoot, 'pj_sick');
		const d = new PipelineJobDriver({
			runner: fake.runner,
			podmanPath: 'podman',
			runtimeDir,
			buildsRoot: async () => buildsRoot,
			stepBinary,
			subidFiles,
			// Every sleep jumps the clock past the health deadline.
			sleep: async () => {
				const now = Date.now();
				Date.now = () => now + 1_000_000;
			},
		});
		const realNow = Date.now;
		try {
			await d.start(parsePipelineJobStart({ ...base, jobId: 'pj_sick', services: [{ name: 'redis', image: 'redis:7', healthCmd: 'redis-cli ping' }] }));
			const failed = await settle(d, 'pj_sick', (state) => state !== 'starting');
			expect(failed.state).toBe('failed');
			expect(failed.error).toContain('Service redis did not become healthy');
			expect(failed.error).toContain('FATAL: boom');
			expect(fake.calls.some((argv) => argv.includes('--name=skiff-job-pj_sick'))).toBe(false);
		} finally {
			Date.now = realNow;
		}
	});

	test('refuses a missing or symlinked job directory and an unavailable runtime', async () => {
		const d = driver(fakeRunner());
		await expect(d.start(parsePipelineJobStart({ ...base, jobId: 'pj_missing' }))).rejects.toThrow(/does not exist/);
		mkdirSync(join(root, 'elsewhere', 'workspace'), { recursive: true });
		symlinkSync(join(root, 'elsewhere'), join(buildsRoot, 'pipelines', 'pj_link'));
		await expect(d.start(parsePipelineJobStart({ ...base, jobId: 'pj_link' }))).rejects.toThrow(ValidationError);
		jobDir(buildsRoot, 'pj_gvisor');
		await expect(d.start(parsePipelineJobStart({ ...base, jobId: 'pj_gvisor', runtime: 'runsc' }))).rejects.toThrow(/runsc runtime is not available/);
	});

	test('BuildKit: buildctl copied once, scoped cache, socket made connectable, BUILDKIT_HOST in the job env', async () => {
		let inspect = '';
		const fake = fakeRunner({ inspect: () => inspect });
		jobDir(buildsRoot, 'pj_bk');
		const paths = pipelineJobPaths(buildsRoot, runtimeDir, 'pj_bk');
		// Stand in for podman: `cp` writes buildctl, `run` of buildkitd creates the socket.
		const runner: CommandRunner = {
			async run(argv) {
				if (argv[1] === 'cp') writeFileSync(argv[3]!, 'buildctl');
				if (argv[1] === 'run' && argv.includes('--name=skiff-job-pj_bk-buildkit')) {
					const server = Bun.listen({ unix: join(paths.buildkitSocketDir, 'buildkitd.sock'), socket: { data() {} } });
					setTimeout(() => server.stop(true), 2_000);
				}
				return fake.runner.run(argv);
			},
		};
		const d = new PipelineJobDriver({ runner, podmanPath: 'podman', runtimeDir, buildsRoot: async () => buildsRoot, stepBinary, subidFiles, sleep: async () => undefined });
		await d.start(parsePipelineJobStart({ ...base, jobId: 'pj_bk', buildkit: true, buildkitCacheScope: 'acme/app:trusted' }));
		inspect = 'running|0|false';
		const status = await settle(d, 'pj_bk', (state) => state !== 'starting');
		expect(status.error).toBeNull();
		expect(status.events.some((event) => event.startsWith('BuildKit 0.34.2 is ready'))).toBe(true);
		expect(statSync(join(paths.buildkitSocketDir, 'buildkitd.sock')).mode & 0o777).toBe(0o666);
		expect(existsSync(join(buildsRoot, 'tools', 'buildctl-0.34.2'))).toBe(true);
		const bk = fake.calls.find((argv) => argv.includes('--name=skiff-job-pj_bk-buildkit'))!;
		expect(bk.find((arg) => arg.includes('/buildkit-cache/'))).toContain(`/buildkit-cache/${cacheScopeDirName('acme/app:trusted')}:`);
		expect(readFileSync(paths.envFile, 'utf8')).toContain(`BUILDKIT_HOST=${BUILDKIT_HOST}\n`);
		const job = fake.calls.find((argv) => argv.includes('--name=skiff-job-pj_bk'))!;
		expect(job).toContain(`--volume=${join(buildsRoot, 'tools', 'buildctl-0.34.2')}:/skiff/bin/buildctl:ro,z`);
		await d.cleanup('pj_bk');
	});
});

describe('routes', () => {
	const calls: string[] = [];
	const api: PipelineJobApi = {
		capabilities: async () => ({
			podman: '5',
			runtimes: ['runc'],
			userns: true,
			fuse: false,
			kvm: false,
			stepBinary: true,
			buildsRoot: '/b',
			buildkit: { version: 'x', image: 'y' },
		}),
		start: async (request) => {
			calls.push(`start ${request.jobId}`);
			return { jobId: request.jobId, state: 'starting', exitCode: null, oomKilled: false, error: null, events: [] };
		},
		status: async (jobId) => ({ jobId, state: 'running', exitCode: null, oomKilled: false, error: null, events: [] }),
		stop: async (jobId, options) => void calls.push(`stop ${jobId} ${options?.force}`),
		cleanup: async (jobId) => void calls.push(`cleanup ${jobId}`),
		list: async () => ['pj_1'],
	};
	const handler = createHandler({} as HelperRuntime, { version: 't', pipelineJobs: api });
	const call = (method: string, path: string, body?: unknown) =>
		handler(new Request(`http://helper${path}`, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }));

	test('verbs, validation and methods', async () => {
		const caps = (await (await call('GET', '/v1/pipeline/capabilities')).json()) as { capabilities: { runtimes: string[] } };
		expect(caps.capabilities.runtimes).toEqual(['runc']);
		const jobs = (await (await call('GET', '/v1/pipeline/jobs')).json()) as { jobs: string[] };
		expect(jobs.jobs).toEqual(['pj_1']);
		expect((await call('POST', '/v1/pipeline/jobs/start', base)).status).toBe(200);
		expect((await call('POST', '/v1/pipeline/jobs/start', { ...base, volumes: ['/:/h'] })).status).toBe(400);
		expect((await call('GET', '/v1/pipeline/jobs/pj_abc123')).status).toBe(200);
		expect((await call('GET', '/v1/pipeline/jobs/..%2Fetc')).status).toBe(400);
		expect((await call('POST', '/v1/pipeline/jobs/pj_1/stop', { force: true })).status).toBe(200);
		expect((await call('POST', '/v1/pipeline/jobs/pj_1/stop')).status).toBe(200);
		expect((await call('POST', '/v1/pipeline/jobs/pj_1/stop', { signal: 9 })).status).toBe(400);
		expect((await call('POST', '/v1/pipeline/jobs/pj_1/cleanup')).status).toBe(200);
		expect((await call('DELETE', '/v1/pipeline/jobs/pj_1')).status).toBe(405);
		expect((await call('GET', '/v1/pipeline/other')).status).toBe(404);
		expect(calls).toEqual(['start pj_abc123', 'stop pj_1 true', 'stop pj_1 false', 'cleanup pj_1']);
		const absent = createHandler({} as HelperRuntime, { version: 't' });
		expect((await absent(new Request('http://helper/v1/pipeline/capabilities'))).status).toBe(404);
	});

	test('routePipelineRequest ignores other paths', async () => {
		expect(await routePipelineRequest(api, { method: 'GET', path: '/v1/pipeline/x/y/z', search: '', readJson: async () => ({}), readText: async () => '' })).toBeNull();
	});
});

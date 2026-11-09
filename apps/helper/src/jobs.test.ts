import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	JOB_SANDBOX_PROPERTIES,
	JobDriver,
	assertJobCommand,
	escapeDollars,
	jobStatusFrom,
	parseJobRequest,
	renderContainerJobArgs,
	renderProcessJobArgs,
	type JobApi,
	type JobRequest,
	type JobStatus,
} from './jobs.ts';
import { createHandler, type HelperRuntime } from './server.ts';
import type { CommandRunner, RunResult } from './systemd.ts';
import { renderProcessUnit } from './units.ts';
import { parseWorkload } from './validate.ts';

const SHA = 'a'.repeat(64);
const RUN = `jr_${'1'.repeat(32)}`;
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function workloadInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'wld_abc123',
		projectId: 'prj_abc123',
		projectSlug: 'my-app',
		deploymentId: 'dep_abc123',
		orgId: 'org_1',
		runtime: 'process',
		status: 'running',
		release: SHA,
		upstream: 'unix//run/yoal-workloads/prj_abc123.sock',
		memoryMb: 256,
		cpus: 1,
		port: 3000,
		healthPath: '/health',
		socketActivation: true,
		activationVersion: 'b'.repeat(64),
		env: { NODE_ENV: 'production' },
		secrets: [{ name: 'TLS_KEY', delivery: 'file' }],
		dataSizeMb: null,
		...overrides,
	};
}

function requestInput(overrides: { run?: Record<string, unknown>; workload?: Record<string, unknown>; activation?: Record<string, unknown> } = {}) {
	return {
		run: { runId: RUN, command: ['bun', 'scripts/migrate.ts', '--to', 'latest version'], timeoutSeconds: 600, ...overrides.run },
		workload: workloadInput(overrides.workload),
		activation: {
			workloadId: 'wld_abc123',
			activationVersion: 'b'.repeat(64),
			env: { DATABASE_URL: 'postgres://secret' },
			files: { TLS_KEY: '-----BEGIN KEY-----' },
			...overrides.activation,
		},
	};
}

describe('request validation', () => {
	test('a well-formed request parses with the workload parser', () => {
		const parsed = parseJobRequest(requestInput());
		expect(parsed.run).toEqual({ runId: RUN, command: ['bun', 'scripts/migrate.ts', '--to', 'latest version'], timeoutSeconds: 600 });
		expect(parsed.workload.id).toBe('wld_abc123');
		expect(parsed.activation.files).toEqual({ TLS_KEY: '-----BEGIN KEY-----' });
	});

	test('run ids, argv, timeouts and extra fields are strict', () => {
		const bad: Array<[Parameters<typeof requestInput>[0], RegExp]> = [
			[{ run: { runId: 'jr_NOPE' } }, /run id/],
			[{ run: { runId: '../../etc' } }, /run id/],
			[{ run: { command: 'bun migrate' } }, /array/],
			[{ run: { command: [] } }, /array/],
			[{ run: { command: ['bun', 'a\nb'] } }, /control character/],
			[{ run: { command: ['FOO=1', 'bun'] } }, /program name/],
			[{ run: { command: ['--help'] } }, /program name/],
			[{ run: { command: ['/usr/bin/../../bin/sh'] } }, /normalized/],
			[{ run: { command: Array.from({ length: 65 }, () => 'x') } }, /array/],
			[{ run: { timeoutSeconds: 5 } }, /timeoutSeconds/],
			[{ run: { timeoutSeconds: 1.5 } }, /timeoutSeconds/],
			[{ run: { shell: true } }, /run.shell is not allowed/],
			[{ workload: { runtime: 'function' } }, /process and container|function/i],
			[{ activation: { activationVersion: 'c'.repeat(64) } }, /activation/],
		];
		for (const [overrides, message] of bad) expect(() => parseJobRequest(requestInput(overrides))).toThrow(message);
		expect(() => parseJobRequest({ ...requestInput(), extra: 1 })).toThrow(/request.extra is not allowed/);
		expect(assertJobCommand(['/opt/app/bin/migrate', '$HOME', '50%'])).toEqual(['/opt/app/bin/migrate', '$HOME', '50%']);
	});
});

describe('rendering', () => {
	const request = () => parseJobRequest(requestInput());

	test('a process run gets the app unit’s sandbox, user, state dir, env and secrets', () => {
		const { run, workload } = request();
		const args = renderProcessJobArgs({
			run,
			workload,
			jobDir: `/run/yoal-workloads/jobs/${RUN}`,
			secrets: [{ name: 'TLS_KEY', path: `/run/yoal-workloads/jobs/${RUN}/secrets/TLS_KEY` }],
			volumeMounts: [
				{ hostPath: '/var/lib/yoal-workloads/apps/prj_abc123/vol_1', mountPath: '/var/lib/app', readOnly: false },
				{ hostPath: '/var/lib/yoal-workloads/apps/prj_abc123/vol_2', mountPath: '/srv/ro', readOnly: true },
			],
			expandFlag: true,
			systemdRunPath: '/usr/bin/systemd-run',
			releaseDir: `/var/lib/yoal/releases/${SHA}`,
			pathDirs: ['/usr/local/bin'],
		});
		const separator = args.indexOf('--');
		expect(args.slice(0, 5)).toEqual([
			'/usr/bin/systemd-run',
			`--unit=yoal-job-${RUN}.service`,
			'--no-block',
			'--quiet',
			`--description=Yoal job ${RUN} for my-app`,
		]);
		const flags = args.slice(0, separator);
		for (const flag of [
			'--expand-environment=no',
			'--property=Type=exec',
			'--property=RemainAfterExit=yes',
			'--property=Restart=no',
			'--property=RuntimeMaxSec=600',
			'--slice=yoal-workloads.slice',
			'--property=MemoryMax=256M',
			'--property=CPUQuota=100%',
			'--property=DynamicUser=yes',
			'--property=User=yoal-workload-wld_abc123',
			'--property=StateDirectory=yoal-workloads/wld_abc123',
			`--working-directory=/var/lib/yoal/releases/${SHA}`,
			`--property=EnvironmentFile=-/run/yoal-workloads/jobs/${RUN}/env`,
			'--setenv=PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin',
			`--property=LoadCredential=TLS_KEY:/run/yoal-workloads/jobs/${RUN}/secrets/TLS_KEY`,
			`--setenv=TLS_KEY_FILE=/run/credentials/yoal-job-${RUN}.service/TLS_KEY`,
			'--property=BindPaths=/var/lib/yoal-workloads/apps/prj_abc123/vol_1:/var/lib/app',
			'--property=ReadWritePaths=/var/lib/app',
			'--property=BindReadOnlyPaths=/var/lib/yoal-workloads/apps/prj_abc123/vol_2:/srv/ro',
		])
			expect(flags).toContain(flag);
		// No secret value, port or socket ever reaches the argv.
		expect(args.join(' ')).not.toContain('postgres://secret');
		expect(args.join(' ')).not.toContain('BEGIN KEY');
		expect(args.some((arg) => arg.startsWith('--setenv=PORT'))).toBe(false);
		// The command is the argv itself, through env for a bare program name.
		expect(args.slice(separator + 1)).toEqual(['/usr/bin/env', 'bun', 'scripts/migrate.ts', '--to', 'latest version']);
	});

	test('the sandbox matches renderProcessUnit directive for directive', () => {
		const unit = renderProcessUnit({
			workload: parseWorkload(workloadInput({ socketActivation: false })),
			releaseDir: `/releases/${SHA}`,
			envFile: '/run/env',
			secrets: [],
			command: ['bun', 'run', 'start'],
			envNames: [],
		});
		const service = unit.split('[Service]')[1]!.split('[Install]')[0]!;
		const sandbox = service
			.split('\n')
			.filter((line) => /^(No|Protect|Private|Restrict|Lock|SystemCall|Capability|Ambient|UMask)/.test(line));
		expect([...JOB_SANDBOX_PROPERTIES]).toEqual(sandbox as never);
	});

	test('older systemd gets `$` doubled instead of the expand flag', () => {
		const { run, workload } = parseJobRequest(requestInput({ run: { command: ['/bin/echo', '$HOME', '${PATH}', 'cost: 5$'] } }));
		const args = renderProcessJobArgs({
			run,
			workload,
			jobDir: '/run/jobs/x',
			secrets: [],
			volumeMounts: [],
			expandFlag: false,
			systemdRunPath: '/usr/bin/systemd-run',
			releaseDir: '/releases/x',
			pathDirs: [],
		});
		expect(args).not.toContain('--expand-environment=no');
		expect(args.slice(args.indexOf('--') + 1)).toEqual(['/bin/echo', '$$HOME', '$${PATH}', 'cost: 5$$']);
		expect(escapeDollars('a$$b')).toBe('a$$$$b');
	});

	test('a container run is podman run --rm in the app’s user namespace, never re-chowning shared data', () => {
		const { run, workload } = parseJobRequest(requestInput({ workload: { runtime: 'container', image: 'ghcr.io/acme/api:1', release: null, socketActivation: false } }));
		const args = renderContainerJobArgs({
			run,
			workload,
			jobDir: `/run/yoal-workloads/jobs/${RUN}`,
			secrets: [{ name: 'TLS_KEY', path: `/run/yoal-workloads/jobs/${RUN}/secrets/TLS_KEY` }],
			volumeMounts: [{ hostPath: '/var/lib/yoal-workloads/apps/prj_abc123/vol_1', mountPath: '/var/lib/app', readOnly: false }],
			expandFlag: true,
			systemdRunPath: '/usr/bin/systemd-run',
			podmanPath: '/usr/bin/podman',
			dataDir: '/var/lib/yoal-workloads/wld_abc123',
			apparmorProfile: null,
		});
		const podman = args.slice(args.indexOf('--') + 1);
		expect(args.slice(0, args.indexOf('--'))).toContain('--property=Delegate=yes');
		expect(podman.slice(0, 3)).toEqual(['/usr/bin/podman', 'run', '--rm']);
		for (const flag of [
			`--name=yoal-job-${RUN}`,
			'--cgroups=split',
			'--log-driver=passthrough',
			'--userns=container:yoal-workload-wld_abc123',
			'--network=yoal-org-org_1',
			`--env-file=/run/yoal-workloads/jobs/${RUN}/env`,
			'--volume=/var/lib/yoal-workloads/wld_abc123:/data',
			'--volume=/var/lib/yoal-workloads/apps/prj_abc123/vol_1:/var/lib/app',
			`--volume=/run/yoal-workloads/jobs/${RUN}/secrets:/run/yoal-secrets:ro,U`,
			'--env=TLS_KEY_FILE=/run/yoal-secrets/TLS_KEY',
			'--cap-drop=all',
			'--read-only',
		])
			expect(podman).toContain(flag);
		// Shared data is mounted as is: no `U` (chown) and no private SELinux relabel.
		expect(podman.filter((arg) => arg.startsWith('--volume=') && !arg.includes('/run/yoal-secrets')).some((arg) => /:(Z|U)|,U/.test(arg))).toBe(false);
		expect(podman.slice(-5)).toEqual(['ghcr.io/acme/api:1', 'bun', 'scripts/migrate.ts', '--to', 'latest version']);
	});
});

describe('status', () => {
	const props = (overrides: Record<string, string>) => ({
		LoadState: 'loaded',
		ActiveState: 'active',
		SubState: 'running',
		Result: 'success',
		ExecMainCode: '0',
		ExecMainStatus: '0',
		ExecMainStartTimestamp: '@1762509600',
		ExecMainExitTimestamp: '',
		ExecMainStartTimestampMonotonic: '1000000',
		ExecMainExitTimestampMonotonic: '0',
		...overrides,
	});

	test('running, succeeded, failed, killed and missing', () => {
		expect(jobStatusFrom(RUN, props({}))).toMatchObject({ outcome: 'running', startedAt: 1762509600000 });
		expect(jobStatusFrom(RUN, props({ SubState: 'exited', ExecMainCode: '1', ExecMainExitTimestamp: '@1762509610' }))).toMatchObject({
			outcome: 'succeeded',
			exitCode: 0,
			finishedAt: 1762509610000,
		});
		expect(jobStatusFrom(RUN, props({ ActiveState: 'failed', Result: 'exit-code', ExecMainCode: '1', ExecMainStatus: '3' }))).toMatchObject({
			outcome: 'failed',
			exitCode: 3,
		});
		expect(jobStatusFrom(RUN, props({ ActiveState: 'failed', Result: 'signal', ExecMainCode: '2', ExecMainStatus: '15' }))).toMatchObject({
			outcome: 'killed',
			signal: 15,
		});
		expect(jobStatusFrom(RUN, { LoadState: 'not-found' }).outcome).toBe('not-found');
		// Exec failed before a main process existed.
		expect(jobStatusFrom(RUN, props({ ActiveState: 'failed', Result: 'exit-code' })).outcome).toBe('failed');
	});

	test('a timeout is a timeout; an early exit that later sat out RuntimeMaxSec is not', () => {
		expect(
			jobStatusFrom(RUN, props({ ActiveState: 'failed', Result: 'timeout', ExecMainCode: '2', ExecMainStatus: '15' }), 60).outcome,
		).toBe('timeout');
		const early = props({ ActiveState: 'failed', Result: 'timeout', ExecMainCode: '1', ExecMainStatus: '0', ExecMainExitTimestampMonotonic: '6000000' });
		expect(jobStatusFrom(RUN, early, 60)).toMatchObject({ outcome: 'succeeded', exitCode: 0 });
		const late = { ...early, ExecMainStatus: '143', ExecMainExitTimestampMonotonic: '61000000' };
		expect(jobStatusFrom(RUN, late, 60).outcome).toBe('timeout');
	});
});

class FakeRunner implements CommandRunner {
	calls: string[][] = [];
	show = 'LoadState=not-found\n';
	version = 'systemd 255 (255.4-1ubuntu8)';
	containerRunning = 'true';

	async run(argv: string[]): Promise<RunResult> {
		this.calls.push(argv);
		if (argv[1] === '--version') return { code: 0, stdout: this.version, stderr: '' };
		if (argv[1] === 'show') return { code: 0, stdout: this.show, stderr: '' };
		if (argv[0]?.endsWith('systemd-run')) {
			this.show = 'LoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nExecMainCode=0\n';
			return { code: 0, stdout: '', stderr: '' };
		}
		if (argv[1] === 'container' && argv[2] === 'inspect') return { code: 0, stdout: `${this.containerRunning}\n`, stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	}
}

async function driverFixture() {
	const root = await fs.mkdtemp(join(tmpdir(), 'yoal-helper-jobs-'));
	directories.push(root);
	const releases = join(root, 'releases');
	await fs.mkdir(join(releases, SHA), { recursive: true });
	const runner = new FakeRunner();
	const driver = new JobDriver({
		runner,
		runtimeDir: join(root, 'run'),
		releaseDirs: [releases],
		bunPath: '/usr/local/bin/bun',
		nodePath: '/usr/local/lib/yoal/node/bin/node',
		systemdRunPath: '/usr/bin/systemd-run',
		systemctlPath: '/usr/bin/systemctl',
		journalctlPath: '/usr/bin/journalctl',
		podmanPath: '/usr/bin/podman',
		resolveAppVolumeMounts: async () => [],
		resolveDataDir: async (workload) => join(root, 'state', workload.id),
	});
	return { root, runner, driver };
}

describe('JobDriver', () => {
	test('start writes owner-only env and secret files, then systemd-run; a second start is the same run', async () => {
		const { root, runner, driver } = await driverFixture();
		const status = await driver.start(parseJobRequest(requestInput()));
		expect(status.outcome).toBe('running');
		const jobDir = join(root, 'run', 'jobs', RUN);
		const env = await fs.readFile(join(jobDir, 'env'), 'utf8');
		expect(env).toContain('DATABASE_URL="postgres://secret"');
		expect(env).toContain('NODE_ENV="production"');
		expect((await fs.stat(join(jobDir, 'env'))).mode & 0o777).toBe(0o400);
		expect((await fs.stat(join(jobDir, 'secrets', 'TLS_KEY'))).mode & 0o777).toBe(0o400);
		expect((await fs.stat(jobDir)).mode & 0o777).toBe(0o700);
		const started = runner.calls.filter((argv) => argv[0] === '/usr/bin/systemd-run' && argv[1] !== '--version');
		expect(started).toHaveLength(1);
		expect(started[0]).toContain('--setenv=PATH=/usr/local/lib/yoal/node/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin');
		await driver.start(parseJobRequest(requestInput()));
		expect(runner.calls.filter((argv) => argv[0] === '/usr/bin/systemd-run' && argv[1] !== '--version')).toHaveLength(1);

		await driver.stop(RUN, { force: true });
		expect(runner.calls).toContainEqual(['/usr/bin/systemctl', 'kill', '--signal=SIGKILL', `yoal-job-${RUN}.service`]);
		await driver.remove(RUN);
		expect(runner.calls).toContainEqual(['/usr/bin/systemctl', 'reset-failed', `yoal-job-${RUN}.service`]);
		expect(runner.calls).toContainEqual(['/usr/bin/podman', 'rm', '--force', '--ignore', `yoal-job-${RUN}`]);
		expect(await fs.stat(jobDir).catch(() => null)).toBeNull();
	});

	test('a missing release, or a container app that is not running, fails before anything is written', async () => {
		const { root, runner, driver } = await driverFixture();
		await expect(driver.start(parseJobRequest(requestInput({ workload: { release: 'c'.repeat(64) } })))).rejects.toThrow(/not present/);
		runner.containerRunning = 'false';
		await expect(
			driver.start(parseJobRequest(requestInput({ workload: { runtime: 'container', image: 'nginx:1', release: null, socketActivation: false } }))),
		).rejects.toThrow(/not running on this node/);
		expect(await fs.stat(join(root, 'run', 'jobs', RUN)).catch(() => null)).toBeNull();
	});

	test('systemd before 254 gets escaped arguments', async () => {
		const { runner, driver } = await driverFixture();
		runner.version = 'systemd 252 (252.30-1~deb12u2)';
		await driver.start(parseJobRequest(requestInput({ run: { command: ['/bin/echo', '$HOME'] } })));
		const argv = runner.calls.find((call) => call[0] === '/usr/bin/systemd-run' && call[1] !== '--version')!;
		expect(argv).not.toContain('--expand-environment=no');
		expect(argv.slice(-2)).toEqual(['/bin/echo', '$$HOME']);
	});
});

class FakeJobs implements JobApi {
	calls: string[] = [];
	async start(request: JobRequest): Promise<JobStatus> {
		this.calls.push(`start:${request.run.runId}`);
		return { runId: request.run.runId, outcome: 'running', exitCode: null, signal: null, startedAt: null, finishedAt: null, result: null };
	}
	async status(runId: string, timeout?: number): Promise<JobStatus> {
		this.calls.push(`status:${runId}:${timeout ?? ''}`);
		return { runId, outcome: 'succeeded', exitCode: 0, signal: null, startedAt: 1, finishedAt: 2, result: 'success' };
	}
	async logs(runId: string) {
		this.calls.push(`logs:${runId}`);
		return { entries: [{ cursor: 'c1', ts: 1, priority: 6, message: 'hello' }], nextCursor: 'c1' };
	}
	async stop(runId: string, options: { force?: boolean } = {}) {
		this.calls.push(`stop:${runId}:${options.force === true}`);
	}
	async remove(runId: string) {
		this.calls.push(`remove:${runId}`);
	}
}

describe('helper verbs', () => {
	const runtime = {} as HelperRuntime;
	const call = (handler: (request: Request) => Promise<Response>, method: string, path: string, body?: unknown) =>
		handler(
			new Request(`http://helper${path}`, {
				method,
				...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
			}),
		);

	test('a helper without jobs answers 404', async () => {
		const response = await call(createHandler(runtime, { version: 'test' }), 'POST', '/v1/jobs', requestInput());
		expect(response.status).toBe(404);
	});

	test('start, status, logs, stop and remove go to the job driver with validated input', async () => {
		const jobs = new FakeJobs();
		const handler = createHandler(runtime, { version: 'test', jobs });
		expect((await call(handler, 'POST', '/v1/jobs', requestInput())).status).toBe(200);
		expect(await (await call(handler, 'GET', `/v1/jobs/${RUN}?timeout=600`)).json()).toMatchObject({ ok: true, job: { outcome: 'succeeded' } });
		expect(await (await call(handler, 'GET', `/v1/jobs/${RUN}/logs?lines=50`)).json()).toMatchObject({ entries: [{ message: 'hello' }] });
		expect((await call(handler, 'POST', `/v1/jobs/${RUN}/stop`)).status).toBe(200);
		expect((await call(handler, 'POST', `/v1/jobs/${RUN}/stop`, { force: true })).status).toBe(200);
		expect((await call(handler, 'DELETE', `/v1/jobs/${RUN}`)).status).toBe(200);
		expect(jobs.calls).toEqual([`start:${RUN}`, `status:${RUN}:600`, `logs:${RUN}`, `stop:${RUN}:false`, `stop:${RUN}:true`, `remove:${RUN}`]);
	});

	test('bad ids, bodies and parameters are 400s that reach nothing', async () => {
		const jobs = new FakeJobs();
		const handler = createHandler(runtime, { version: 'test', jobs });
		expect((await call(handler, 'GET', '/v1/jobs/jr_bad')).status).toBe(400);
		expect((await call(handler, 'GET', `/v1/jobs/${RUN}?timeout=-1`)).status).toBe(400);
		expect((await call(handler, 'GET', `/v1/jobs/${RUN}/logs?lines=5000`)).status).toBe(400);
		expect((await call(handler, 'POST', `/v1/jobs/${RUN}/stop`, { force: 'yes' })).status).toBe(400);
		expect((await call(handler, 'POST', `/v1/jobs/${RUN}/stop`, { signal: 'SIGHUP' })).status).toBe(400);
		expect((await call(handler, 'POST', `/v1/jobs/${RUN}/stop`, '{nope')).status).toBe(400);
		expect((await call(handler, 'DELETE', `/v1/jobs/${RUN}`, { all: true })).status).toBe(400);
		expect((await call(handler, 'POST', '/v1/jobs', requestInput({ run: { command: 'rm -rf /' } }))).status).toBe(400);
		expect((await call(handler, 'PUT', '/v1/jobs')).status).toBe(405);
		expect(jobs.calls).toEqual([]);
	});
});

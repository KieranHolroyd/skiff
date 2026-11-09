import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PipelineJobClaim, PipelineJobComplete } from '@yoal/contracts';
import { interpolate } from '@yoal/contracts';
import { BuildValidationError, redactSecret, systemdRunArgs } from '../command.ts';
import type { BuilderConfig, PipelineIsolation } from '../config.ts';
import { ConfigError } from '../config.ts';
import { JobApi, isLeaseLost } from './client.ts';
import { buildJobContext, runnerArch, runnerOs } from './context.ts';
import { capture, cloneAtSha, withCloneToken } from './git.ts';
import { PipelineHelperClient, readK8sLog, type HelperPipelineService, type PipelineHelper } from './helper-client.ts';
import { LogBatcher, pumpLines } from './logs.ts';
import { Masker } from './masker.ts';
import {
	CONTAINER_PATHS,
	jobContainerName,
	jobNetworkName,
	podmanJobArgs,
	podmanServiceArgs,
	qualifyImageRef,
	serviceContainerName,
	validateJobId,
	validateServiceName,
} from './podman.ts';

/**
 * Host side of one pipeline job (docs/PIPELINES.md §4.2). Runs as the Builder daemon (root on a
 * node, the developer locally): prepares `<buildDir>/pipelines/<jobId>/{workspace,home,tmp,meta}`,
 * clones the exact commit, starts the step runner in a Podman container (`container`) or a
 * sandboxed systemd unit / child process (`sandbox`), renews the lease every 15 s, forwards a
 * cancel as SIGTERM, kills at the timeout, completes the job itself if the step runner could not,
 * and always tears down.
 *
 * `container` isolation goes through yoal-helper's fixed verbs (W5, `helper-client.ts`): the
 * helper derives every mount from the job id, starts services and the BuildKit sidecar (W6), and
 * runs the job container; the Builder polls its status every second and tails
 * `<job dir>/runner.log` (the step runner's stdout/stderr, Podman `k8s-file` format) into its own
 * journal. Job logs proper go from the step runner to the control plane, as in every mode.
 * `YOAL_PIPELINE_CONTAINER_DRIVER=podman` keeps the old direct-Podman path for development
 * (macOS with a Podman machine); it has no BuildKit sidecar.
 */

const HEARTBEAT_MS = 15_000;
/** How long a cancelled step runner gets to run always() steps before it is killed. */
const CANCEL_GRACE_SECONDS = 30;
const SERVICE_HEALTH_TIMEOUT_MS = 120_000;
const HELPER_POLL_MS = 1_000;
/** Consecutive failed status polls before the job is given up (the helper restarted or is gone). */
const HELPER_POLL_FAILURES = 30;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The command that runs `pipeline-step <job.json>`. A compiled agent or builder is its own step
 * runner; from source, the agent entry point under Bun. A container needs one self-contained file
 * to bind-mount, so source mode cannot use container isolation without an explicit binary.
 */
export function resolveStepCommand(input: {
	explicit: string | null;
	isolation: PipelineIsolation;
	main: string;
	execPath: string;
	agentMain?: string;
}): string[] {
	if (input.explicit) return [input.explicit];
	if (input.main.endsWith('.ts')) {
		if (input.isolation === 'container')
			throw new ConfigError('Container isolation needs a compiled step runner: set YOAL_PIPELINE_STEP_BINARY');
		return [input.execPath, input.agentMain ?? fileURLToPath(new URL('../../../agent/src/main.ts', import.meta.url))];
	}
	return [input.execPath];
}

interface JobDirs {
	root: string;
	workspace: string;
	home: string;
	tmp: string;
	meta: string;
}

export function jobDirs(buildDir: string, jobId: string): JobDirs {
	const root = join(buildDir, 'pipelines', validateJobId(jobId));
	return { root, workspace: join(root, 'workspace'), home: join(root, 'home'), tmp: join(root, 'tmp'), meta: join(root, 'meta') };
}

/** A running step runner, however it was started. */
interface StepProcess {
	exited: Promise<number>;
	/** SIGTERM to the step runner only; it stops the running step and runs always() steps. */
	terminate(): void;
	/** SIGKILL everything. */
	kill(): void;
}

export class PipelineExecutor {
	private readonly helper: PipelineHelper;

	constructor(
		private readonly config: BuilderConfig,
		private readonly log: (message: string) => void = (message) => console.log(`[pipeline] ${message}`),
		options: { helper?: PipelineHelper } = {},
	) {
		this.helper = options.helper ?? new PipelineHelperClient(config.helperSocket);
	}

	/** Containers start through yoal-helper (the default), not by running Podman here. */
	private get viaHelper(): boolean {
		return this.config.pipelineIsolation === 'container' && this.config.pipelineContainerDriver === 'helper';
	}

	/** Remove `yoal-job-*` containers, networks and job directories left by a previous daemon. */
	async reapOrphans(): Promise<void> {
		if (this.viaHelper) {
			const ids = await this.helper.list();
			for (const id of ids) await this.helper.cleanup(id).catch((error: unknown) => this.log(`could not clean up job ${id}: ${errorText(error)}`));
			if (ids.length) this.log(`reaped ${ids.length} orphaned job(s) through yoal-helper`);
		} else if (this.config.pipelineIsolation === 'container') {
			const containers = await capture(['podman', 'ps', '-a', '--filter', 'name=^yoal-job-', '--format', '{{.Names}}']);
			const names = containers.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
			if (names.length) await capture(['podman', 'rm', '-f', '-t', '5', ...names]);
			const networks = await capture(['podman', 'network', 'ls', '--filter', 'name=^yoal-job-', '--format', '{{.Name}}']);
			const nets = networks.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
			if (nets.length) await capture(['podman', 'network', 'rm', '-f', ...nets]);
			if (names.length || nets.length) this.log(`reaped ${names.length} orphaned containers and ${nets.length} networks`);
		}
		await rm(join(this.config.buildDir, 'pipelines'), { recursive: true, force: true }).catch(() => undefined);
	}

	async run(claim: PipelineJobClaim): Promise<void> {
		const config = this.config;
		const jobId = validateJobId(claim.jobId);
		const dirs = jobDirs(config.buildDir, jobId);
		const api = new JobApi(config.controlUrl, claim.token);
		const masker = new Masker();
		masker.add(claim.token);
		if (config.gitToken) masker.add(config.gitToken);
		if (claim.gitToken) masker.add(claim.gitToken);
		const logs = new LogBatcher(api, masker, { onError: (error) => this.log(`${jobId} log upload failed: ${errorText(error)}`) });
		const isolation = config.pipelineIsolation;
		const limitMinutes = Math.min(claim.job.timeoutMinutes || Infinity, claim.limits.timeoutMinutes || Infinity);
		const hardLimitMs = ((Number.isFinite(limitMinutes) ? limitMinutes : 360) + 2) * 60_000;

		let cancelRequested = false;
		let leaseLost = false;
		let hostTimedOut = false;
		let step: StepProcess | null = null;
		let graceTimer: ReturnType<typeof setTimeout> | null = null;
		const services: string[] = [];
		let network: string | null = null;

		const requestCancel = (why: string) => {
			if (cancelRequested) return;
			cancelRequested = true;
			this.log(`${jobId} ${why}; stopping the step runner`);
			if (step) {
				step.terminate();
				graceTimer = setTimeout(() => step?.kill(), (CANCEL_GRACE_SECONDS + 5) * 1_000);
			}
		};
		const heartbeat = setInterval(() => {
			api.heartbeat().then(
				(response) => {
					if (response?.cancelled) requestCancel('cancelled by the control plane');
				},
				(error: unknown) => {
					if (isLeaseLost(error)) {
						leaseLost = true;
						requestCancel(`lost its lease (${errorText(error)})`);
					} else this.log(`${jobId} heartbeat failed: ${errorText(error)}`);
				},
			);
		}, HEARTBEAT_MS);
		const hardTimer = setTimeout(() => {
			hostTimedOut = true;
			this.log(`${jobId} exceeded its time limit; killing`);
			step?.kill();
		}, hardLimitMs);

		const complete = async (body: PipelineJobComplete) => {
			await logs.close();
			if (leaseLost) return;
			await api.complete(body).catch((error: unknown) => this.log(`${jobId} complete failed: ${errorText(error)}`));
		};

		try {
			if (isolation === 'sandbox' && (claim.job.container || Object.keys(claim.job.services).length))
				throw new BuildValidationError(
					'This job uses container: or services:, which need container isolation (Podman). This node runs jobs in the sandbox; ' +
						'add a node with YOAL_PIPELINE_ISOLATION=container or remove them.',
				);
			// Through the helper, the step runner is the node's own agent binary, chosen by the helper.
			const stepCommand = this.viaHelper
				? []
				: resolveStepCommand({
						explicit: config.pipelineStepBinary,
						isolation,
						main: Bun.main,
						execPath: process.execPath,
					});
			const image = isolation === 'container' ? qualifyImageRef(claim.job.container?.image ?? claim.image) : null;

			await rm(dirs.root, { recursive: true, force: true });
			for (const dir of [dirs.workspace, dirs.home, dirs.tmp, dirs.meta]) await mkdir(dir, { recursive: true, mode: 0o700 });

			logs.system(-1, `Checking out ${claim.repository.name} at ${claim.checkout.sha} (${claim.checkout.ref})`);
			await cloneAtSha({
				url: claim.repository.cloneUrl,
				ref: claim.checkout.ref,
				sha: claim.checkout.sha,
				dir: dirs.workspace,
				credentials: withCloneToken(config, claim.gitToken, { host: claim.gitTokenHost, username: claim.gitTokenUsername }),
			});
			// The tokens travel in the environment only; job.json is readable by the job's steps (and
			// the clone token must never reach an untrusted job).
			const jobFile = join(dirs.meta, 'job.json');
			await writeFile(jobFile, JSON.stringify({ ...claim, token: '', gitToken: null }), { mode: 0o600 });

			if (cancelRequested) {
				await complete({ conclusion: 'cancelled', outputs: {} });
				return;
			}

			const env = {
				YOAL_JOB_TOKEN: claim.token,
				YOAL_CONTROL_URL: config.pipelineControlUrl,
				YOAL_RUNNER_NAME: config.pipelineRunnerName,
			};
			if (this.viaHelper) {
				step = await this.startViaHelper(claim, dirs, image!, env, api, masker, logs);
			} else if (isolation === 'container') {
				await capture(['podman', 'pull', '--quiet', image!]).then((pull) => {
					if (pull.code !== 0) throw new Error(`Could not pull ${image}: ${pull.stderr.trim().slice(0, 1000)}`);
				});
				logs.system(-1, `Using image ${image}`);
				if (Object.keys(claim.job.services).length) {
					network = jobNetworkName(jobId);
					await this.startServices(claim, api, masker, logs, network, services);
				}
				step = this.spawnContainer(claim, dirs, image!, stepCommand, network, env);
			} else {
				if (config.buildUser) await this.handOver(dirs.root);
				step = this.spawnSandbox(claim, dirs, stepCommand, jobFile, env, hardLimitMs);
			}
			if (cancelRequested) step.terminate();
			const code = await step.exited;
			if (code === 0 && !hostTimedOut) {
				this.log(`${jobId} finished`);
				await logs.close();
				return;
			}
			const conclusion: PipelineJobComplete['conclusion'] = hostTimedOut ? 'timed_out' : cancelRequested ? 'cancelled' : 'failure';
			const error = hostTimedOut
				? 'The job exceeded its time limit and was killed.'
				: `The step runner exited with code ${code} without completing the job.`;
			logs.system(-1, error);
			await complete({ conclusion, outputs: {}, error });
		} catch (error) {
			const message = redactSecret(redactSecret(errorText(error), config.gitToken), claim.gitToken ?? null).slice(0, 4000);
			this.log(`${jobId} failed: ${message}`);
			logs.system(-1, `Error: ${message}`);
			await complete({ conclusion: cancelRequested ? 'cancelled' : 'failure', outputs: {}, error: message });
		} finally {
			clearInterval(heartbeat);
			clearTimeout(hardTimer);
			if (graceTimer) clearTimeout(graceTimer);
			await this.teardown(jobId, services, network, dirs);
			await logs.close().catch(() => undefined);
		}
	}

	/** Give the job directory to the unprivileged build account (sandbox with systemd-run). */
	private async handOver(dir: string): Promise<void> {
		const user = this.config.buildUser!;
		const result = await capture(['chown', '-R', '--no-dereference', `${user}:${user}`, dir]);
		if (result.code !== 0)
			throw new Error(`Could not hand the job directory to ${user}: ${result.stderr.trim().slice(0, 500) || `exit ${result.code}`}`);
	}

	private async startServices(
		claim: PipelineJobClaim,
		api: JobApi,
		masker: Masker,
		logs: LogBatcher,
		network: string,
		started: string[],
	): Promise<void> {
		const created = await capture(['podman', 'network', 'create', network]);
		if (created.code !== 0) throw new Error(`Could not create the job network: ${created.stderr.trim().slice(0, 500)}`);
		const specs = Object.entries(claim.job.services);
		// Only fetch secrets on the host when a service needs one (`env: { PASSWORD: ${{ secrets.X }} }`).
		const secrets = JSON.stringify(specs).includes('secrets') ? await api.secrets() : {};
		masker.addAll(Object.values(secrets));
		const context = buildJobContext({
			claim,
			secrets,
			runner: {
				os: runnerOs(),
				arch: runnerArch(),
				name: this.config.pipelineRunnerName,
				temp: CONTAINER_PATHS.tmp,
				tool_cache: join(CONTAINER_PATHS.home, 'tool-cache'),
				workspace: CONTAINER_PATHS.workspace,
			},
		});
		for (const [name, spec] of specs) {
			const env: Record<string, string> = {};
			for (const [key, template] of Object.entries(spec.env)) env[key] = interpolate(template, context);
			const argv = podmanServiceArgs({ jobId: claim.jobId, name, spec, env, network, memoryMb: claim.limits.memoryMb });
			logs.system(-1, `Starting service ${name} (${spec.image})`);
			const result = await capture(argv, { env });
			const container = serviceContainerName(claim.jobId, name);
			started.push(container);
			if (result.code !== 0) throw new Error(`Service ${name} did not start: ${masker.mask(result.stderr.trim()).slice(0, 1000)}`);
			await this.waitHealthy(name, container, Boolean(spec.healthCmd), logs);
		}
	}

	private async waitHealthy(name: string, container: string, hasHealthCmd: boolean, logs: LogBatcher): Promise<void> {
		const deadline = Date.now() + SERVICE_HEALTH_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const result = hasHealthCmd
				? await capture(['podman', 'healthcheck', 'run', container])
				: await capture(['podman', 'container', 'inspect', '--format', '{{.State.Running}}', container]);
			const ok = hasHealthCmd ? result.code === 0 : result.stdout.trim() === 'true';
			if (ok) {
				logs.system(-1, `Service ${name} is ${hasHealthCmd ? 'healthy' : 'running'}`);
				return;
			}
			const running = await capture(['podman', 'container', 'inspect', '--format', '{{.State.Running}}', container]);
			if (running.stdout.trim() !== 'true') break;
			await Bun.sleep(2_000);
		}
		const tail = await capture(['podman', 'logs', '--tail', '50', container]);
		for (const line of `${tail.stdout}${tail.stderr}`.split('\n').filter(Boolean)) logs.push(-1, 'stderr', `[${name}] ${line}`);
		throw new Error(`Service ${name} did not become ${hasHealthCmd ? 'healthy' : 'ready'} within ${SERVICE_HEALTH_TIMEOUT_MS / 1000}s`);
	}

	private pipeDiagnostics(jobId: string, proc: { stdout: unknown; stderr: unknown }): void {
		const print = (line: string) => this.log(`${jobId} | ${line}`);
		void pumpLines(proc.stdout as ReadableStream<Uint8Array>, print);
		void pumpLines(proc.stderr as ReadableStream<Uint8Array>, print);
	}

	private spawnContainer(
		claim: PipelineJobClaim,
		dirs: JobDirs,
		image: string,
		stepCommand: string[],
		network: string | null,
		env: Record<string, string>,
	): StepProcess {
		if (stepCommand.length !== 1) throw new ConfigError('Container isolation needs a single compiled step-runner binary');
		const name = jobContainerName(claim.jobId);
		const argv = podmanJobArgs({
			jobId: claim.jobId,
			image,
			dirs,
			stepBinary: stepCommand[0]!,
			memoryMb: claim.limits.memoryMb,
			cpus: claim.limits.cpus,
			network,
			ociBuild: claim.job.runsOn.includes('oci-build'),
			fuse: existsSync('/dev/fuse'),
			env: {
				YOAL_CONTROL_URL: env.YOAL_CONTROL_URL!,
				YOAL_RUNNER_NAME: env.YOAL_RUNNER_NAME!,
				YOAL_PIPELINE_WORKSPACE: CONTAINER_PATHS.workspace,
				YOAL_PIPELINE_TEMP: CONTAINER_PATHS.tmp,
			},
			inheritEnv: ['YOAL_JOB_TOKEN'],
		});
		const proc = Bun.spawn(argv, { env: { ...process.env, ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
		this.pipeDiagnostics(claim.jobId, proc);
		const fire = (args: string[]) => void capture(args).catch(() => undefined);
		return {
			exited: proc.exited,
			terminate: () => fire(['podman', 'stop', '-t', String(CANCEL_GRACE_SECONDS), name]),
			kill: () => fire(['podman', 'kill', name]),
		};
	}

	private spawnSandbox(
		claim: PipelineJobClaim,
		dirs: JobDirs,
		stepCommand: string[],
		jobFile: string,
		env: Record<string, string>,
		hardLimitMs: number,
	): StepProcess {
		const config = this.config;
		const stepEnv: Record<string, string> = {
			HOME: dirs.home,
			YOAL_CONTROL_URL: env.YOAL_CONTROL_URL!,
			YOAL_RUNNER_NAME: env.YOAL_RUNNER_NAME!,
			YOAL_PIPELINE_WORKSPACE: dirs.workspace,
			YOAL_PIPELINE_TEMP: dirs.tmp,
		};
		const argv = [...stepCommand, 'pipeline-step', jobFile];
		if (config.systemd) {
			const unit = `yoal-job-${validateJobId(claim.jobId)}`;
			const command = systemdRunArgs({
				workDir: dirs.workspace,
				writableDir: dirs.root,
				argv,
				unit,
				memoryMax: `${Math.floor(claim.limits.memoryMb)}M`,
				cpuQuota: `${Math.round(claim.limits.cpus * 100)}%`,
				timeoutSeconds: Math.ceil(hardLimitMs / 1000),
				user: config.buildUser,
				env: { ...stepEnv, PATH: config.buildPath },
				inheritEnv: ['YOAL_JOB_TOKEN'],
			});
			const proc = Bun.spawn(command, {
				env: { ...process.env, YOAL_JOB_TOKEN: env.YOAL_JOB_TOKEN },
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
			});
			this.pipeDiagnostics(claim.jobId, proc);
			const fire = (args: string[]) => void capture(args).catch(() => undefined);
			return {
				exited: proc.exited,
				// Main process only: the step runner then stops the step's process group itself.
				terminate: () => fire(['systemctl', 'kill', '--kill-whom=main', '--signal=SIGTERM', `${unit}.service`]),
				kill: () => fire(['systemctl', 'kill', '--signal=SIGKILL', `${unit}.service`]),
			};
		}
		// Direct execution (development, macOS): the developer's own account and PATH.
		const proc = Bun.spawn(argv, {
			cwd: dirs.workspace,
			env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: process.env.LANG ?? 'C.UTF-8', ...stepEnv, YOAL_JOB_TOKEN: env.YOAL_JOB_TOKEN! },
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		});
		this.pipeDiagnostics(claim.jobId, proc);
		return {
			exited: proc.exited,
			terminate: () => proc.kill('SIGTERM'),
			kill: () => proc.kill('SIGKILL'),
		};
	}

	/**
	 * Start the job through yoal-helper and follow it: progress events become system log lines,
	 * the step runner's own output goes to this daemon's journal, and `exited` resolves with its
	 * exit code (or rejects with the helper's reason when the job never started).
	 */
	private async startViaHelper(
		claim: PipelineJobClaim,
		dirs: JobDirs,
		image: string,
		env: Record<string, string>,
		api: JobApi,
		masker: Masker,
		logs: LogBatcher,
	): Promise<StepProcess> {
		const jobId = claim.jobId;
		const services = await this.helperServices(claim, api, masker);
		await this.helper.start({
			jobId,
			image,
			memoryMb: Math.max(64, Math.floor(claim.limits.memoryMb)),
			cpus: Math.max(0.1, claim.limits.cpus),
			runtime: claim.runtime ?? 'runc',
			profile: claim.job.runsOn.includes('oci-build') ? 'oci-build' : 'default',
			// Values travel in the request body and land in a 0400 env file; never in argv.
			env: Object.entries(env).map(([name, value]) => `${name}=${value}`),
			services,
			buildkit: claim.buildkit === true,
			buildkitCacheScope: claim.buildkitCacheScope ?? null,
		});
		logs.system(-1, `Using image ${image}${claim.runtime && claim.runtime !== 'runc' ? ` (runtime ${claim.runtime})` : ''}`);
		const runnerLog = join(dirs.root, 'runner.log');
		let offset = 0;
		let seen = 0;
		let failures = 0;
		const tail = async () => {
			const read = await readK8sLog(runnerLog, offset).catch(() => ({ lines: [] as string[], offset }));
			offset = read.offset;
			for (const line of read.lines) this.log(`${jobId} | ${masker.mask(line)}`);
		};
		const exited = (async () => {
			for (;;) {
				let status;
				try {
					status = await this.helper.status(jobId);
					failures = 0;
				} catch (error) {
					if (++failures >= HELPER_POLL_FAILURES) throw new Error(`Lost track of the job container: ${errorText(error)}`);
					await Bun.sleep(HELPER_POLL_MS);
					continue;
				}
				for (const event of status.events.slice(seen)) logs.system(-1, masker.mask(event));
				seen = Math.max(seen, status.events.length);
				await tail();
				if (status.state === 'exited') {
					if (status.oomKilled) logs.system(-1, `The job ran out of memory (limit ${claim.limits.memoryMb} MB) and was killed.`);
					return status.exitCode ?? 1;
				}
				if (status.state === 'failed') throw new Error(masker.mask(status.error ?? 'The job container did not start'));
				if (status.state === 'not-found') throw new Error('The job container is gone');
				await Bun.sleep(HELPER_POLL_MS);
			}
		})();
		const fire = (force: boolean) =>
			void this.helper.stop(jobId, force).catch((error: unknown) => this.log(`${jobId} stop failed: ${errorText(error)}`));
		return { exited, terminate: () => fire(false), kill: () => fire(true) };
	}

	/** `services:` with their `env:` templates evaluated here (they may name secrets). */
	private async helperServices(claim: PipelineJobClaim, api: JobApi, masker: Masker): Promise<HelperPipelineService[]> {
		const specs = Object.entries(claim.job.services);
		if (!specs.length) return [];
		const secrets = JSON.stringify(specs).includes('secrets') ? await api.secrets() : {};
		masker.addAll(Object.values(secrets));
		const context = buildJobContext({
			claim,
			secrets,
			runner: {
				os: runnerOs(),
				arch: runnerArch(),
				name: this.config.pipelineRunnerName,
				temp: CONTAINER_PATHS.tmp,
				tool_cache: join(CONTAINER_PATHS.home, 'tool-cache'),
				workspace: CONTAINER_PATHS.workspace,
			},
		});
		return specs.map(([name, spec]) => ({
			name: validateServiceName(name),
			image: qualifyImageRef(spec.image),
			env: Object.entries(spec.env).map(([key, template]) => `${key}=${interpolate(template, context)}`),
			healthCmd: spec.healthCmd,
		}));
	}

	private async teardown(jobId: string, services: string[], network: string | null, dirs: JobDirs): Promise<void> {
		if (this.viaHelper) {
			await this.helper.cleanup(jobId).catch((error: unknown) => this.log(`${jobId} cleanup through yoal-helper failed: ${errorText(error)}`));
		} else if (this.config.pipelineIsolation === 'container') {
			const names = [jobContainerName(jobId), ...services];
			await capture(['podman', 'rm', '-f', '-t', '5', ...names]).catch(() => undefined);
			if (network) await capture(['podman', 'network', 'rm', '-f', network]).catch(() => undefined);
		}
		await rm(dirs.root, { recursive: true, force: true }).catch((error: unknown) =>
			this.log(`${jobId} could not remove ${dirs.root}: ${errorText(error)}`),
		);
	}
}

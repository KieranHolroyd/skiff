import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandRunner, RunResult } from './systemd.ts';
import { renderContainerEnvFile, renderEnvFile, WORKLOAD_SLICE, type UnitVolumeMount } from './units.ts';
import {
	assertRecord,
	assertRelativePath,
	parseApplyRequest,
	ValidationError,
	workloadNetworkName,
	type WorkloadActivation,
	type WorkloadDesired,
} from './validate.ts';

/**
 * Job runs (plan 09, docs/SCHEDULER.md §Jobs): one command of a process or container app, run
 * once in a transient systemd unit with the app's sandbox, env, secrets and volumes.
 *
 * The agent sends the run (id, argv, timeout) with the app's desired workload and activation;
 * nothing else reaches a unit. `systemd-run` starts `skiff-job-<run id>.service` without a
 * daemon-reload:
 *
 * - **Process apps** get the app unit's sandbox (same directives as `renderProcessUnit`), its
 *   dynamic user and state directory (so files the app wrote stay readable), its release as the
 *   working directory, its env file and file secrets as credentials, and its volumes.
 * - **Container apps** get `podman run --rm` of the app's image, joined to the running app
 *   container's user namespace so `/data` and volumes are already owned by the right uid and are
 *   never re-chowned under the app. The app must be running.
 *
 * `RemainAfterExit=yes` keeps the exit status readable until the agent removes the unit, and
 * `RuntimeMaxSec` is the timeout. The argv is never a shell string: it is passed to systemd as an
 * array, with `$` escaped (or expansion turned off on systemd 254+), and a bare program name goes
 * through `/usr/bin/env` inside the sandbox so `PATH` and the release directory apply.
 */

export const JOB_RUN_ID_PATTERN = /^jr_[a-f0-9]{32}$/;
export const JOB_UNIT_PREFIX = 'skiff-job-';
export const JOB_MIN_TIMEOUT_SECONDS = 10;
export const JOB_MAX_TIMEOUT_SECONDS = 86_400;
/** Job directories (and so units) a node holds at once; the agent runs at most 8. */
export const JOB_MAX_LIVE = 32;
/** systemd's grace between SIGTERM and SIGKILL when a run is stopped or times out. */
export const JOB_STOP_TIMEOUT_SECONDS = 30;
const MAX_COMMAND_ARGS = 64;
const MAX_COMMAND_ARG = 1024;
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SECRETS_MOUNT = '/run/skiff-secrets';

/**
 * The process app sandbox, one-for-one with `renderProcessUnit` (units.ts). A test keeps the two
 * in step: a directive added there must be added here.
 */
export const JOB_SANDBOX_PROPERTIES = [
	'NoNewPrivileges=yes',
	'ProtectSystem=strict',
	'ProtectHome=yes',
	'PrivateTmp=yes',
	'PrivateDevices=yes',
	'ProtectClock=yes',
	'ProtectHostname=yes',
	'ProtectKernelTunables=yes',
	'ProtectKernelModules=yes',
	'ProtectKernelLogs=yes',
	'ProtectControlGroups=yes',
	'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
	'RestrictNamespaces=yes',
	'RestrictRealtime=yes',
	'RestrictSUIDSGID=yes',
	'LockPersonality=yes',
	'SystemCallArchitectures=native',
	'CapabilityBoundingSet=',
	'AmbientCapabilities=',
	'UMask=0077',
] as const;

export interface JobRunSpec {
	runId: string;
	command: string[];
	timeoutSeconds: number;
}

export interface JobRequest {
	run: JobRunSpec;
	workload: WorkloadDesired;
	activation: WorkloadActivation;
}

/** What the helper saw of a run's unit. `outcome` is the helper's reading of systemd's fields. */
export interface JobStatus {
	runId: string;
	outcome: 'running' | 'succeeded' | 'failed' | 'timeout' | 'killed' | 'not-found';
	exitCode: number | null;
	signal: number | null;
	/** Epoch ms, from systemd's `ExecMainStartTimestamp` / `ExecMainExitTimestamp`. */
	startedAt: number | null;
	finishedAt: number | null;
	/** systemd's `Result=` (`success`, `exit-code`, `timeout`, `signal`, …). */
	result: string | null;
}

export interface JobLogEntry {
	cursor: string;
	ts: number;
	priority: number;
	message: string;
}

export interface JobApi {
	start(request: JobRequest): Promise<JobStatus>;
	status(runId: string, timeoutSeconds?: number): Promise<JobStatus>;
	logs(runId: string, options?: { cursor?: string; lines?: number }): Promise<{ entries: JobLogEntry[]; nextCursor: string | null }>;
	stop(runId: string, options?: { force?: boolean }): Promise<void>;
	remove(runId: string): Promise<void>;
}

// -------------------------------------------------------------------- validation

export function assertRunId(value: unknown): string {
	if (typeof value !== 'string' || !JOB_RUN_ID_PATTERN.test(value)) throw new ValidationError(`run id must match ${JOB_RUN_ID_PATTERN}`);
	return value;
}

export function jobUnitName(runId: string): string {
	return `${JOB_UNIT_PREFIX}${assertRunId(runId)}.service`;
}

/** A fixed argv: 1–64 arguments, each 1–1024 characters with no control characters. */
export function assertJobCommand(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMMAND_ARGS)
		throw new ValidationError(`run.command must be an array of 1 to ${MAX_COMMAND_ARGS} arguments`);
	const command = value.map((arg, index) => {
		if (typeof arg !== 'string' || arg.length === 0 || arg.length > MAX_COMMAND_ARG)
			throw new ValidationError(`run.command[${index}] must be a string of 1 to ${MAX_COMMAND_ARG} characters`);
		if (/[\u0000-\u001f\u007f]/.test(arg)) throw new ValidationError(`run.command[${index}] contains a control character`);
		return arg;
	});
	// `/usr/bin/env` would read a leading NAME=VALUE as an assignment, and a leading `-` as an option.
	const program = command[0]!;
	if (!program.startsWith('/') && (program.includes('=') || program.startsWith('-')))
		throw new ValidationError('run.command[0] must be a program name or an absolute path');
	if (program.startsWith('/') && (program.includes('/../') || program.endsWith('/..')))
		throw new ValidationError('run.command[0] must be a normalized absolute path');
	return command;
}

/**
 * `{ run, workload, activation }`. The workload and activation go through the same parser as
 * `POST /v1/workloads`; only process and container apps run jobs.
 */
export function parseJobRequest(value: unknown): JobRequest {
	const record = assertRecord(value, 'request');
	const run = assertRecord(record.run, 'run');
	for (const key of Object.keys(run))
		if (!['runId', 'command', 'timeoutSeconds'].includes(key)) throw new ValidationError(`run.${key} is not allowed`);
	const timeoutSeconds = run.timeoutSeconds;
	if (
		typeof timeoutSeconds !== 'number' ||
		!Number.isInteger(timeoutSeconds) ||
		timeoutSeconds < JOB_MIN_TIMEOUT_SECONDS ||
		timeoutSeconds > JOB_MAX_TIMEOUT_SECONDS
	)
		throw new ValidationError(`run.timeoutSeconds must be an integer from ${JOB_MIN_TIMEOUT_SECONDS} to ${JOB_MAX_TIMEOUT_SECONDS}`);
	for (const key of Object.keys(record))
		if (!['run', 'workload', 'activation'].includes(key)) throw new ValidationError(`request.${key} is not allowed`);
	const { workload, activation } = parseApplyRequest({ workload: record.workload, activation: record.activation });
	if (workload.runtime !== 'process' && workload.runtime !== 'container')
		throw new ValidationError('Jobs run on process and container apps only');
	if (workload.database || workload.objectStorage || workload.broker || workload.registry)
		throw new ValidationError('Jobs run on apps, not managed services');
	if (workload.runner) throw new ValidationError('CI runner pools do not run jobs');
	if (workload.runtime === 'container' && !workload.image) throw new ValidationError('Container jobs need workload.image');
	return {
		run: { runId: assertRunId(run.runId), command: assertJobCommand(run.command), timeoutSeconds },
		workload,
		activation,
	};
}

// -------------------------------------------------------------------- rendering

export interface JobUnitOptions {
	run: JobRunSpec;
	workload: WorkloadDesired;
	/** `<runtimeDir>/jobs/<run id>`: env file and secrets, owner-only. */
	jobDir: string;
	secrets: Array<{ name: string; path: string }>;
	volumeMounts: UnitVolumeMount[];
	/** systemd ≥ 254 takes `--expand-environment=no`; older ones need `$` doubled. */
	expandFlag: boolean;
	systemdRunPath: string;
}

export interface ProcessJobOptions extends JobUnitOptions {
	releaseDir: string;
	/** Directories of the node's bun and node, put ahead of the default `PATH`. */
	pathDirs: string[];
}

export interface ContainerJobOptions extends JobUnitOptions {
	podmanPath: string;
	dataDir: string;
	apparmorProfile: string | null;
}

/** systemd expands `$NAME` and `${NAME}` in a command line; `$$` is a literal `$`. */
export function escapeDollars(arg: string): string {
	// A function replacer: in a replacement string `$$` would itself mean one `$`.
	return arg.replaceAll('$', () => '$$');
}

function cpuQuota(cpus: number): string {
	return `${Math.max(1, Math.round(cpus * 100))}%`;
}

/** The flags every job unit shares: identity, lifecycle, limits. */
function commonArgs(options: JobUnitOptions): string[] {
	const { run, workload } = options;
	return [
		options.systemdRunPath,
		`--unit=${jobUnitName(run.runId)}`,
		'--no-block',
		'--quiet',
		`--description=Skiff job ${run.runId} for ${workload.projectSlug}`,
		...(options.expandFlag ? ['--expand-environment=no'] : []),
		'--property=Type=exec',
		'--property=RemainAfterExit=yes',
		'--property=Restart=no',
		`--property=RuntimeMaxSec=${run.timeoutSeconds}`,
		`--property=TimeoutStopSec=${JOB_STOP_TIMEOUT_SECONDS}`,
		`--slice=${WORKLOAD_SLICE}`,
		`--property=MemoryMax=${workload.memoryMb}M`,
		`--property=CPUQuota=${cpuQuota(workload.cpus)}`,
	];
}

function commandTail(command: string[], expandFlag: boolean): string[] {
	return expandFlag ? command : command.map(escapeDollars);
}

/** `systemd-run` argv for a process app's run. */
export function renderProcessJobArgs(options: ProcessJobOptions): string[] {
	const { run, workload } = options;
	const unit = jobUnitName(run.runId);
	const args = commonArgs(options);
	// The app's own dynamic user (systemd names it after the unit) and state directory: a run
	// sees exactly the files the app wrote, and nothing is re-chowned.
	args.push('--property=DynamicUser=yes');
	args.push(`--property=User=skiff-workload-${workload.id}`);
	args.push(`--property=StateDirectory=skiff-workloads/${workload.id}`);
	args.push('--property=StateDirectoryMode=0700');
	args.push(`--working-directory=${options.releaseDir}`);
	args.push(`--property=EnvironmentFile=-${join(options.jobDir, 'env')}`);
	const path = [...new Set([...options.pathDirs, ...DEFAULT_PATH.split(':')])].join(':');
	args.push(`--setenv=PATH=${path}`);
	for (const secret of options.secrets) {
		args.push(`--property=LoadCredential=${secret.name}:${secret.path}`);
		// `%d` is not expanded for a transient unit; this is where systemd puts credentials.
		args.push(`--setenv=${secret.name}_FILE=/run/credentials/${unit}/${secret.name}`);
	}
	for (const mount of options.volumeMounts) {
		args.push(`--property=${mount.readOnly ? 'BindReadOnlyPaths' : 'BindPaths'}=${mount.hostPath}:${mount.mountPath}`);
		if (!mount.readOnly) args.push(`--property=ReadWritePaths=${mount.mountPath}`);
	}
	args.push('--property=KillSignal=SIGTERM');
	for (const property of JOB_SANDBOX_PROPERTIES) args.push(`--property=${property}`);
	args.push('--');
	const [program] = run.command;
	const command = program!.startsWith('/') ? run.command : ['/usr/bin/env', ...run.command];
	args.push(...commandTail(command, options.expandFlag));
	return args;
}

export function jobContainerName(runId: string): string {
	return `${JOB_UNIT_PREFIX}${assertRunId(runId)}`;
}

export function appContainerName(workloadId: string): string {
	return `skiff-workload-${workloadId}`;
}

/** `systemd-run` argv for a container app's run: `podman run --rm` in the app's user namespace. */
export function renderContainerJobArgs(options: ContainerJobOptions): string[] {
	const { run, workload } = options;
	const args = commonArgs(options);
	// Podman makes a sub-cgroup for conmon and the container (`--cgroups=split`); SIGTERM goes to
	// podman, which forwards it, and the rest of the cgroup is killed after the stop timeout.
	args.push('--property=Delegate=yes');
	args.push('--property=KillMode=mixed');
	args.push('--');
	const podman = [
		options.podmanPath,
		'run',
		'--rm',
		`--name=${jobContainerName(run.runId)}`,
		`--label=skiff.job=${run.runId}`,
		'--cgroups=split',
		'--log-driver=passthrough',
		'--pull=missing',
		// The app container's user namespace: its uid owns /data and the volumes already.
		`--userns=container:${appContainerName(workload.id)}`,
		`--network=${workloadNetworkName(workload)}`,
		`--env-file=${join(options.jobDir, 'env')}`,
		`--volume=${options.dataDir}:/data`,
	];
	for (const mount of options.volumeMounts) podman.push(`--volume=${mount.hostPath}:${mount.mountPath}${mount.readOnly ? ':ro' : ''}`);
	if (options.secrets.length > 0) {
		// The run's own copies; `U` hands them to the container uid, and they are deleted after.
		podman.push(`--volume=${join(options.jobDir, 'secrets')}:${SECRETS_MOUNT}:ro,U`);
		for (const secret of options.secrets) podman.push(`--env=${secret.name}_FILE=${SECRETS_MOUNT}/${secret.name}`);
	}
	podman.push('--cap-drop=all', '--security-opt=no-new-privileges', '--read-only', '--tmpfs=/tmp:rw,size=64m');
	if (options.apparmorProfile) podman.push(`--security-opt=apparmor=${options.apparmorProfile}`);
	podman.push(workload.image!, ...run.command);
	args.push(...commandTail(podman, options.expandFlag));
	return args;
}

// -------------------------------------------------------------------- status

export const JOB_STATUS_PROPERTIES = [
	'LoadState',
	'ActiveState',
	'SubState',
	'Result',
	'ExecMainCode',
	'ExecMainStatus',
	'ExecMainStartTimestamp',
	'ExecMainExitTimestamp',
	'ExecMainStartTimestampMonotonic',
	'ExecMainExitTimestampMonotonic',
] as const;

export function parseShowOutput(stdout: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of stdout.split('\n')) {
		const index = line.indexOf('=');
		if (index > 0) out[line.slice(0, index)] = line.slice(index + 1).trim();
	}
	return out;
}

/** `@1730000000` (from `--timestamp=unix`) → epoch ms; anything else → null. */
function unixTimestamp(value: string | undefined): number | null {
	const match = /^@(\d+)$/.exec(value ?? '');
	return match ? Number(match[1]) * 1000 : null;
}

/**
 * Read systemd's fields. `ExecMainCode` is the kernel's `si_code`: 0 while the main process runs,
 * 1 exited (status = exit code), 2 killed / 3 dumped (status = signal). A run that exited on its
 * own before its timeout succeeded or failed by its exit code, even if the remaining "exited"
 * state later ran into `RuntimeMaxSec`.
 */
export function jobStatusFrom(runId: string, props: Record<string, string>, timeoutSeconds?: number): JobStatus {
	const base = {
		runId,
		exitCode: null as number | null,
		signal: null as number | null,
		startedAt: unixTimestamp(props.ExecMainStartTimestamp),
		finishedAt: unixTimestamp(props.ExecMainExitTimestamp),
		result: props.Result || null,
	};
	if (!props.LoadState || props.LoadState === 'not-found') return { ...base, outcome: 'not-found' };
	const code = Number(props.ExecMainCode ?? 0);
	const status = Number(props.ExecMainStatus ?? 0);
	const timedOut = props.Result === 'timeout';
	if (!Number.isFinite(code) || code === 0) {
		const settled = props.ActiveState === 'failed' || props.ActiveState === 'inactive';
		// Never started (exec failed before a main process existed): report the failure.
		if (settled) return { ...base, outcome: timedOut ? 'timeout' : 'failed' };
		return { ...base, outcome: 'running' };
	}
	if (code === 1) {
		const start = Number(props.ExecMainStartTimestampMonotonic ?? 0);
		const exit = Number(props.ExecMainExitTimestampMonotonic ?? 0);
		const ranFor = exit > start && start > 0 ? (exit - start) / 1_000_000 : null;
		const hitTimeout = timedOut && (timeoutSeconds === undefined || ranFor === null || ranFor >= timeoutSeconds - 1);
		if (hitTimeout) return { ...base, exitCode: status, outcome: 'timeout' };
		return { ...base, exitCode: status, outcome: status === 0 ? 'succeeded' : 'failed' };
	}
	return { ...base, signal: status, outcome: timedOut ? 'timeout' : 'killed' };
}

// -------------------------------------------------------------------- driver

export interface JobDriverOptions {
	runner: CommandRunner;
	/** `/run/skiff-workloads`: job dirs live under `<runtimeDir>/jobs`. */
	runtimeDir: string;
	releaseDirs: string[];
	bunPath: string;
	nodePath: string;
	systemdRunPath: string;
	systemctlPath: string;
	journalctlPath: string;
	podmanPath: string;
	apparmorProfile?: string | null;
	/** The workload driver's resolvers (they verify disk mounts before anything starts). */
	resolveAppVolumeMounts(workload: WorkloadDesired): Promise<UnitVolumeMount[]>;
	resolveDataDir(workload: WorkloadDesired): Promise<string>;
}

export class JobDriver implements JobApi {
	private systemdVersion: Promise<number> | null = null;
	/** Timeouts by run id, so `status` can tell an early exit from a timeout. */
	private readonly timeouts = new Map<string, number>();

	constructor(private readonly options: JobDriverOptions) {}

	private jobsDir(): string {
		return join(this.options.runtimeDir, 'jobs');
	}

	private jobDir(runId: string): string {
		return join(this.jobsDir(), assertRunId(runId));
	}

	async start(request: JobRequest): Promise<JobStatus> {
		const { run, workload, activation } = request;
		const unit = jobUnitName(run.runId);
		const existing = await this.status(run.runId);
		// Idempotent: an agent that restarted mid-start asks again and gets the same run.
		if (existing.outcome !== 'not-found') return existing;
		const live = await fs.readdir(this.jobsDir()).catch(() => [] as string[]);
		if (live.filter((name) => JOB_RUN_ID_PATTERN.test(name)).length >= JOB_MAX_LIVE)
			throw new ValidationError(`This node already holds ${JOB_MAX_LIVE} job runs; remove finished ones first`);

		// Resolve everything that can fail before a secret is written.
		let releaseDir: string | null = null;
		let dataDir: string | null = null;
		if (workload.runtime === 'process') {
			releaseDir = await this.resolveRelease(workload.release!);
		} else {
			dataDir = await this.options.resolveDataDir(workload);
			await this.requireAppContainer(workload);
		}
		const volumeMounts = await this.options.resolveAppVolumeMounts(workload);

		const jobDir = this.jobDir(run.runId);
		await fs.mkdir(this.jobsDir(), { recursive: true, mode: 0o700 });
		await fs.mkdir(jobDir, { recursive: true, mode: 0o700 });
		await fs.chmod(jobDir, 0o700).catch(() => undefined);
		const env = { ...workload.env, ...activation.env };
		const envText = workload.runtime === 'container' ? renderContainerEnvFile(env) : renderEnvFile(env);
		await writeFile(join(jobDir, 'env'), envText, 0o400);
		const secrets = await this.writeSecrets(join(jobDir, 'secrets'), workload, activation);
		const expandFlag = (await this.version()) >= 254;
		const common = { run, workload, jobDir, secrets, volumeMounts, expandFlag, systemdRunPath: this.options.systemdRunPath };
		const argv =
			workload.runtime === 'process'
				? renderProcessJobArgs({
						...common,
						releaseDir: releaseDir!,
						pathDirs: [dirname(this.options.nodePath), dirname(this.options.bunPath)],
					})
				: renderContainerJobArgs({
						...common,
						podmanPath: this.options.podmanPath,
						dataDir: dataDir!,
						apparmorProfile: this.options.apparmorProfile ?? null,
					});
		const result = await this.options.runner.run(argv);
		if (result.code !== 0) {
			await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
			throw new Error(`systemd-run ${unit} failed (${result.code}): ${detail(result)}`);
		}
		this.timeouts.set(run.runId, run.timeoutSeconds);
		return this.status(run.runId, run.timeoutSeconds);
	}

	async status(runId: string, timeoutSeconds?: number): Promise<JobStatus> {
		const unit = jobUnitName(runId);
		const result = await this.options.runner.run([
			this.options.systemctlPath,
			'show',
			'--timestamp=unix',
			...JOB_STATUS_PROPERTIES.flatMap((name) => ['-p', name]),
			unit,
		]);
		if (result.code !== 0) throw new Error(`systemctl show ${unit} failed (${result.code}): ${detail(result)}`);
		return jobStatusFrom(runId, parseShowOutput(result.stdout), timeoutSeconds ?? this.timeouts.get(runId));
	}

	async logs(runId: string, options: { cursor?: string; lines?: number } = {}): Promise<{ entries: JobLogEntry[]; nextCursor: string | null }> {
		const unit = jobUnitName(runId);
		const lines = Math.max(1, Math.min(Math.floor(options.lines ?? 200), 1_000));
		const args = [
			this.options.journalctlPath,
			'-u',
			unit,
			'--no-pager',
			'-o',
			'json',
			'--output-fields=__CURSOR,__REALTIME_TIMESTAMP,MESSAGE,PRIORITY',
			'-n',
			String(lines),
		];
		const cursor = options.cursor?.trim();
		if (cursor) args.push('--after-cursor', cursor);
		const result = await this.options.runner.run(args);
		if (result.code !== 0) throw new Error(`journalctl for ${unit} failed (${result.code}): ${detail(result)}`);
		const entries: JobLogEntry[] = [];
		for (const line of result.stdout.split('\n')) {
			const entry = journalEntry(line);
			if (entry) entries.push(entry);
		}
		entries.sort((a, b) => a.ts - b.ts);
		return { entries, nextCursor: entries.at(-1)?.cursor ?? cursor ?? null };
	}

	/**
	 * Signal the run's processes: SIGTERM, or SIGKILL with `force` (the agent escalates after
	 * `JOB_STOP_TIMEOUT_SECONDS`). The unit stays loaded so its exit can still be read.
	 */
	async stop(runId: string, options: { force?: boolean } = {}): Promise<void> {
		const unit = jobUnitName(runId);
		const signal = options.force ? 'SIGKILL' : 'SIGTERM';
		const result = await this.options.runner.run([this.options.systemctlPath, 'kill', `--signal=${signal}`, unit]);
		// `kill` on a unit with no process left fails; that is a stopped run.
		if (result.code !== 0 && !/not loaded|no such|not running|has no|not active/i.test(`${result.stderr}${result.stdout}`))
			throw new Error(`systemctl kill ${unit} failed (${result.code}): ${detail(result)}`);
	}

	/** Forget the unit, any leftover container and the run's env and secret files. Idempotent. */
	async remove(runId: string): Promise<void> {
		const unit = jobUnitName(runId);
		await this.options.runner.run([this.options.systemctlPath, 'stop', unit]);
		await this.options.runner.run([this.options.systemctlPath, 'reset-failed', unit]);
		await this.options.runner.run([this.options.podmanPath, 'rm', '--force', '--ignore', jobContainerName(runId)]);
		await fs.rm(this.jobDir(runId), { recursive: true, force: true });
		this.timeouts.delete(runId);
	}

	private version(): Promise<number> {
		this.systemdVersion ??= this.options.runner
			.run([this.options.systemdRunPath, '--version'])
			.then((result) => Number(/systemd (\d+)/.exec(result.stdout)?.[1] ?? 0))
			.catch(() => 0);
		return this.systemdVersion;
	}

	private async requireAppContainer(workload: WorkloadDesired): Promise<void> {
		const name = appContainerName(workload.id);
		const result = await this.options.runner.run([this.options.podmanPath, 'container', 'inspect', '--format', '{{.State.Running}}', name]);
		if (result.code !== 0 || result.stdout.trim() !== 'true')
			throw new ValidationError(`${workload.projectSlug} is not running on this node; container jobs run beside the running app. Start it first.`);
	}

	private async resolveRelease(sha256: string): Promise<string> {
		for (const root of this.options.releaseDirs) {
			const candidate = join(root, sha256);
			const stat = await fs.stat(candidate).catch(() => null);
			if (stat?.isDirectory()) return candidate;
		}
		throw new ValidationError(`Release ${sha256} is not present on this node`);
	}

	private async writeSecrets(dir: string, workload: WorkloadDesired, activation: WorkloadActivation): Promise<Array<{ name: string; path: string }>> {
		const expected = new Set(workload.secrets.filter((secret) => secret.delivery === 'file').map((secret) => secret.name));
		const entries = Object.entries(activation.files).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) return [];
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		const files: Array<{ name: string; path: string }> = [];
		for (const [name, value] of entries) {
			if (!expected.has(name)) throw new ValidationError(`activation file ${name} is not a file secret of this workload`);
			assertRelativePath(name, 'secret file name');
			const path = join(dir, name);
			await writeFile(path, value, 0o400);
			files.push({ name, path });
		}
		return files;
	}
}

async function writeFile(path: string, content: string, mode: number): Promise<void> {
	await fs.rm(path, { force: true });
	await fs.writeFile(path, content, { mode, flag: 'wx' });
	await fs.chmod(path, mode);
}

function journalEntry(line: string): JobLogEntry | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let record: Record<string, unknown>;
	try {
		record = JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return null;
	}
	const cursor = record.__CURSOR;
	if (typeof cursor !== 'string') return null;
	const raw = record.MESSAGE;
	// journald sends non-UTF-8 messages as a byte array.
	const message = typeof raw === 'string' ? raw : Array.isArray(raw) ? Buffer.from(raw as number[]).toString('utf8') : '';
	const ts = Math.floor(Number(record.__REALTIME_TIMESTAMP ?? 0) / 1000);
	const priority = Number(record.PRIORITY ?? 6);
	return {
		cursor,
		ts: Number.isFinite(ts) ? ts : 0,
		priority: Number.isInteger(priority) ? Math.max(0, Math.min(priority, 7)) : 6,
		message: message.slice(0, 16_384),
	};
}

function detail(result: RunResult): string {
	return (result.stderr.trim() || result.stdout.trim() || 'no output').slice(0, 500);
}

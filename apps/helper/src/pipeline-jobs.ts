import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner, RunResult } from './systemd.ts';
import { ensureContainerSubids, type SubidFiles } from './userns.ts';
import { assertAbsolutePath, assertEnvName, assertImage, assertRecord, ValidationError } from './validate.ts';

/**
 * Pipeline job containers (docs/PIPELINES.md W5, W6, W14): the fixed helper verbs that start,
 * follow, stop and remove one CI job's Podman containers, so the Builder daemon never runs Podman
 * itself (D43, D151).
 *
 * The request carries only validated values: a job id, an image reference, limits, an OCI runtime
 * from a fixed list, a profile from a fixed list, `NAME=VALUE` environment entries, service
 * containers, and a BuildKit flag with a cache scope. Every host path is derived here:
 *
 * - `<buildsRoot>/pipelines/<jobId>/{workspace,home,tmp,meta}`: the job directory the Builder
 *   created and cloned into (it must exist, be root-owned and not a symlink). `buildsRoot` is the
 *   Builder's `SKIFF_BUILD_DIR`, read from its unit drop-in, never from the request.
 * - `<buildsRoot>/pipelines/<jobId>/runner.log`: the step runner's stdout/stderr (`k8s-file` log
 *   driver), outside every mount. The Builder tails it for its own diagnostics; job logs proper go
 *   from the step runner to the control plane.
 * - `<runtimeDir>/pipeline-jobs/<jobId>/`: 0400 env files (`--env-file`, so values never reach
 *   argv), service logs and the BuildKit socket directory. Removed by `cleanup`.
 * - `<buildsRoot>/buildkit-cache/<scope>`: one BuildKit state directory per cache scope.
 * - `<buildsRoot>/tools/`: the step runner (a copy of the node's agent binary) and `buildctl`
 *   (copied once out of the pinned BuildKit image), bind-mounted read-only at `/skiff/bin`.
 *
 * Starting is asynchronous: `start` validates, writes the env files and returns `starting`; image
 * pulls, the job network, services (with health checks), the BuildKit sidecar and finally the job
 * container follow in the background. The Builder polls `status` (cheap `podman inspect`).
 */

export const PIPELINE_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
export const PIPELINE_RUNTIMES = ['runc', 'runsc', 'kata'] as const;
export type PipelineRuntime = (typeof PIPELINE_RUNTIMES)[number];
export const PIPELINE_PROFILES = ['default', 'oci-build'] as const;
export type PipelineProfile = (typeof PIPELINE_PROFILES)[number];

/** Label on every container of a job, so cleanup and reaping never depend on helper memory. */
export const PIPELINE_JOB_LABEL = 'skiff.pipeline-job';
export const PIPELINE_MAX_LIVE = 16;
export const PIPELINE_MAX_SERVICES = 8;
export const PIPELINE_MAX_ENV = 256;
/** Podman's `--env-file` reader is a line scanner with a 64 KiB line limit. */
export const PIPELINE_MAX_ENV_VALUE = 32_768;
export const PIPELINE_MIN_MEMORY_MB = 64;
export const PIPELINE_MAX_MEMORY_MB = 262_144;
export const SERVICE_HEALTH_TIMEOUT_MS = 120_000;
export const BUILDKIT_READY_TIMEOUT_MS = 60_000;
const EVENT_LIMIT = 50;

/** Where things live inside the job container. The Builder writes `job.json` into `meta`. */
export const PIPELINE_CONTAINER_PATHS = {
	workspace: '/workspace',
	meta: '/skiff/meta',
	home: '/skiff/home',
	tmp: '/skiff/tmp',
	bin: '/skiff/bin',
	stepBinary: '/skiff/bin/skiff-step',
	buildctl: '/skiff/bin/buildctl',
	jobFile: '/skiff/meta/job.json',
	buildkitDir: '/skiff/buildkit',
} as const;

/**
 * The BuildKit sidecar (W6), pinned like D61: the request only says "BuildKit, yes or no".
 * Rootless image: `rootlesskit buildkitd` as uid 1000, which maps 1..65536 to 100000..165535 in a
 * nested namespace, so the container's own namespace needs 165 536 ids.
 */
export const BUILDKIT = {
	version: '0.34.2',
	// Multi-arch index (linux/amd64 + linux/arm64), resolved 2026-11-08.
	image: 'docker.io/moby/buildkit:v0.34.2-rootless@sha256:c8252268760e1baba80780d63d738ef9f260fb7c7c0973c78494cb9ddd99eda1',
	usernsSize: 165_536,
	stateDir: '/home/user/.local/share/buildkit',
	buildctlInImage: '/usr/bin/buildctl',
	socketName: 'buildkitd.sock',
} as const;
export const BUILDKIT_HOST = `unix://${PIPELINE_CONTAINER_PATHS.buildkitDir}/${BUILDKIT.socketName}`;

/** Names the helper sets itself; a request may not override them. */
const RESERVED_ENV = new Set(['HOME', 'PATH', 'BUILDKIT_HOST', 'SKIFF_PIPELINE_WORKSPACE', 'SKIFF_PIPELINE_TEMP', 'SKIFF_BUILDCTL']);
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Podman's own lookup table for `--runtime <name>` (containers.conf `[engine.runtimes]`). */
export const RUNTIME_PATHS: Record<Exclude<PipelineRuntime, 'runc'>, string[]> = {
	runsc: ['/usr/bin/runsc', '/usr/sbin/runsc', '/usr/local/bin/runsc', '/usr/local/sbin/runsc', '/bin/runsc', '/sbin/runsc'],
	kata: [
		'/usr/bin/kata-runtime',
		'/usr/sbin/kata-runtime',
		'/usr/local/bin/kata-runtime',
		'/usr/local/sbin/kata-runtime',
		'/sbin/kata-runtime',
		'/bin/kata-runtime',
		'/usr/bin/kata-qemu',
		'/usr/bin/kata-fc',
	],
};

// -------------------------------------------------------------------- request

export interface PipelineServiceSpec {
	/** Container name suffix and the default DNS alias. */
	name: string;
	image: string;
	env: Array<[string, string]>;
	healthCmd: string | null;
	/** DNS names on the job network; defaults to `[name]`. */
	aliases: string[];
}

export interface PipelineJobStartRequest {
	jobId: string;
	image: string;
	memoryMb: number;
	cpus: number;
	runtime: PipelineRuntime;
	profile: PipelineProfile;
	env: Array<[string, string]>;
	services: PipelineServiceSpec[];
	buildkit: boolean;
	buildkitCacheScope: string | null;
}

export function assertPipelineJobId(value: unknown): string {
	if (typeof value !== 'string' || !PIPELINE_JOB_ID_PATTERN.test(value))
		throw new ValidationError(`jobId must match ${PIPELINE_JOB_ID_PATTERN}`);
	return value;
}

function onlyKeys(record: Record<string, unknown>, allowed: string[], label: string): void {
	for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new ValidationError(`${label}.${key} is not allowed`);
}

/**
 * Docker's short-name rules, made explicit: `postgres:17` → `docker.io/library/postgres:17`.
 * Podman would otherwise consult registries.conf, and refuses an ambiguous short name without a TTY.
 */
export function qualifyImage(image: string): string {
	const slash = image.indexOf('/');
	const first = slash < 0 ? '' : image.slice(0, slash);
	if (slash >= 0 && (first.includes('.') || first.includes(':') || first === 'localhost')) return image;
	return slash < 0 ? `docker.io/library/${image}` : `docker.io/${image}`;
}

function parseImage(value: unknown, label: string): string {
	return qualifyImage(assertImage(value, label));
}

function parseEnvList(value: unknown, label: string): Array<[string, string]> {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > PIPELINE_MAX_ENV)
		throw new ValidationError(`${label} must be an array of at most ${PIPELINE_MAX_ENV} NAME=VALUE strings`);
	const seen = new Set<string>();
	return value.map((entry, index) => {
		if (typeof entry !== 'string') throw new ValidationError(`${label}[${index}] must be a NAME=VALUE string`);
		const eq = entry.indexOf('=');
		if (eq <= 0) throw new ValidationError(`${label}[${index}] must be a NAME=VALUE string`);
		const name = assertEnvName(entry.slice(0, eq), `${label}[${index}] name`);
		const text = entry.slice(eq + 1);
		if (text.length > PIPELINE_MAX_ENV_VALUE) throw new ValidationError(`${label}.${name} is longer than ${PIPELINE_MAX_ENV_VALUE} characters`);
		if (/[\r\n\0]/.test(text)) throw new ValidationError(`${label}.${name} contains a line break or NUL, which an env file cannot carry`);
		if (seen.has(name)) throw new ValidationError(`${label} sets ${name} twice`);
		seen.add(name);
		return [name, text] as [string, string];
	});
}

/** A DNS label: service names become container-name suffixes and network aliases. */
function parseServiceName(value: unknown, label: string): string {
	if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value))
		throw new ValidationError(`${label} must be a lowercase DNS label`);
	return value;
}

/** Runs as `/bin/sh -c` inside the service container (Podman's health check), never on the host. */
function parseHealthCmd(value: unknown, label: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value))
		throw new ValidationError(`${label} must be 1 to 1024 characters without control characters`);
	return value;
}

function parseService(value: unknown, index: number): PipelineServiceSpec {
	const label = `services[${index}]`;
	const record = assertRecord(value, label);
	onlyKeys(record, ['name', 'image', 'env', 'healthCmd', 'aliases'], label);
	const name = parseServiceName(record.name, `${label}.name`);
	let aliases = [name];
	if (record.aliases !== undefined) {
		if (!Array.isArray(record.aliases) || record.aliases.length === 0 || record.aliases.length > 8)
			throw new ValidationError(`${label}.aliases must be an array of 1 to 8 DNS labels`);
		aliases = [...new Set(record.aliases.map((alias, i) => parseServiceName(alias, `${label}.aliases[${i}]`)))];
	}
	return {
		name,
		image: parseImage(record.image, `${label}.image`),
		env: parseEnvList(record.env, `${label}.env`),
		healthCmd: parseHealthCmd(record.healthCmd, `${label}.healthCmd`),
		aliases,
	};
}

export function parsePipelineJobStart(value: unknown): PipelineJobStartRequest {
	const record = assertRecord(value, 'request');
	onlyKeys(
		record,
		['jobId', 'image', 'memoryMb', 'cpus', 'runtime', 'profile', 'env', 'services', 'buildkit', 'buildkitCacheScope'],
		'request',
	);
	const memoryMb = record.memoryMb;
	if (typeof memoryMb !== 'number' || !Number.isInteger(memoryMb) || memoryMb < PIPELINE_MIN_MEMORY_MB || memoryMb > PIPELINE_MAX_MEMORY_MB)
		throw new ValidationError(`memoryMb must be an integer from ${PIPELINE_MIN_MEMORY_MB} to ${PIPELINE_MAX_MEMORY_MB}`);
	const cpus = record.cpus;
	if (typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus < 0.1 || cpus > 256)
		throw new ValidationError('cpus must be a number from 0.1 to 256');
	const runtime = record.runtime ?? 'runc';
	if (!(PIPELINE_RUNTIMES as readonly unknown[]).includes(runtime)) throw new ValidationError(`runtime must be one of ${PIPELINE_RUNTIMES.join(', ')}`);
	const profile = record.profile ?? 'default';
	if (!(PIPELINE_PROFILES as readonly unknown[]).includes(profile)) throw new ValidationError(`profile must be one of ${PIPELINE_PROFILES.join(', ')}`);
	const env = parseEnvList(record.env, 'env');
	for (const [name] of env) if (RESERVED_ENV.has(name)) throw new ValidationError(`env.${name} is set by the helper`);
	let services: PipelineServiceSpec[] = [];
	if (record.services !== undefined) {
		if (!Array.isArray(record.services) || record.services.length > PIPELINE_MAX_SERVICES)
			throw new ValidationError(`services must be an array of at most ${PIPELINE_MAX_SERVICES}`);
		services = record.services.map(parseService);
		const names = new Set<string>();
		const aliases = new Set<string>();
		for (const service of services) {
			if (names.has(service.name)) throw new ValidationError(`service ${service.name} is listed twice`);
			names.add(service.name);
			for (const alias of service.aliases) {
				if (aliases.has(alias)) throw new ValidationError(`network alias ${alias} is used twice`);
				aliases.add(alias);
			}
		}
	}
	const buildkit = record.buildkit ?? false;
	if (typeof buildkit !== 'boolean') throw new ValidationError('buildkit must be a boolean');
	let buildkitCacheScope: string | null = null;
	if (record.buildkitCacheScope !== undefined && record.buildkitCacheScope !== null) {
		if (typeof record.buildkitCacheScope !== 'string' || record.buildkitCacheScope.length === 0 || record.buildkitCacheScope.length > 512)
			throw new ValidationError('buildkitCacheScope must be a string of 1 to 512 characters');
		if (/[\u0000-\u001f\u007f]/.test(record.buildkitCacheScope)) throw new ValidationError('buildkitCacheScope contains a control character');
		buildkitCacheScope = record.buildkitCacheScope;
	}
	return {
		jobId: assertPipelineJobId(record.jobId),
		image: parseImage(record.image, 'image'),
		memoryMb,
		cpus,
		runtime: runtime as PipelineRuntime,
		profile: profile as PipelineProfile,
		env,
		services,
		buildkit,
		buildkitCacheScope: buildkit ? buildkitCacheScope : null,
	};
}

// -------------------------------------------------------------------- paths

export interface PipelineJobPaths {
	jobRoot: string;
	workspace: string;
	home: string;
	tmp: string;
	meta: string;
	runnerLog: string;
	/** Helper-owned, 0700: env files, service logs, the BuildKit socket directory. */
	runtime: string;
	envFile: string;
	buildkitSocketDir: string;
}

export function pipelineJobPaths(buildsRoot: string, runtimeDir: string, jobId: string): PipelineJobPaths {
	const id = assertPipelineJobId(jobId);
	const jobRoot = join(buildsRoot, 'pipelines', id);
	const runtime = join(runtimeDir, 'pipeline-jobs', id);
	return {
		jobRoot,
		workspace: join(jobRoot, 'workspace'),
		home: join(jobRoot, 'home'),
		tmp: join(jobRoot, 'tmp'),
		meta: join(jobRoot, 'meta'),
		runnerLog: join(jobRoot, 'runner.log'),
		runtime,
		envFile: join(runtime, 'job.env'),
		buildkitSocketDir: join(runtime, 'buildkit'),
	};
}

export const serviceEnvFile = (paths: PipelineJobPaths, service: string) => join(paths.runtime, `svc-${service}.env`);
export const serviceLogFile = (paths: PipelineJobPaths, service: string) => join(paths.runtime, `svc-${service}.log`);

/**
 * A cache scope as one directory name of `[a-z0-9._-]`. A scope that is already such a name (and
 * at most 64 characters) is used as it is; anything else keeps a readable prefix plus a hash of
 * the original, so two scopes never collapse into one directory (W10: trusted and untrusted caches
 * must not mix because their names sanitize alike).
 */
export function cacheScopeDirName(scope: string): string {
	if (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(scope)) return scope;
	const hash = createHash('sha256').update(scope).digest('hex').slice(0, 16);
	const prefix = scope
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^[^a-z0-9]+/, '')
		.slice(0, 40)
		.replace(/[^a-z0-9]+$/, '');
	return prefix ? `${prefix}-${hash}` : hash;
}

export function buildkitCacheDir(buildsRoot: string, scope: string | null, jobId: string): string {
	// No scope: a private, throwaway cache for this job only.
	return join(buildsRoot, 'buildkit-cache', scope === null ? `job-${assertPipelineJobId(jobId)}` : cacheScopeDirName(scope));
}

export const jobContainerName = (jobId: string) => `skiff-job-${assertPipelineJobId(jobId)}`;
export const jobNetworkName = (jobId: string) => `skiff-job-${assertPipelineJobId(jobId)}`;
export const serviceContainerName = (jobId: string, service: string) => `skiff-job-${assertPipelineJobId(jobId)}-svc-${service}`;
export const buildkitContainerName = (jobId: string) => `skiff-job-${assertPipelineJobId(jobId)}-buildkit`;

/** The Builder's `SKIFF_BUILD_DIR`: the helper's override, else the D48 drop-in, else the default. */
export const DEFAULT_BUILDS_ROOT = '/var/lib/skiff-builder';
export const BUILDER_STORAGE_DROP_IN = 'skiff-builder.service.d/skiff-storage.conf';

export async function resolveBuildsRoot(options: { override?: string | null; unitDir: string }): Promise<string> {
	if (options.override) return assertAbsolutePath(options.override, 'SKIFF_HELPER_BUILDS_DIR');
	const text = await fs.readFile(join(options.unitDir, BUILDER_STORAGE_DROP_IN), 'utf8').catch(() => '');
	const match = /^Environment=SKIFF_BUILD_DIR=(\S+)\s*$/m.exec(text);
	return match ? assertAbsolutePath(match[1], 'SKIFF_BUILD_DIR in the Builder drop-in') : DEFAULT_BUILDS_ROOT;
}

// -------------------------------------------------------------------- rendering

/** `NAME=VALUE` lines for `podman --env-file`. Values were checked for line breaks at parse time. */
export function renderEnvFile(env: Array<[string, string]>): string {
	return env.length ? `${env.map(([name, value]) => `${name}=${value}`).join('\n')}\n` : '';
}

function runtimeArgs(runtime: PipelineRuntime): string[] {
	// `runc` means "the node's default OCI runtime" (crun or runc): no flag.
	if (runtime === 'runc') return [];
	// runsc refuses a SELinux process label ("SELinux is not supported", WS4); its own sentry is the
	// boundary. A no-op on AppArmor hosts.
	if (runtime === 'runsc') return ['--runtime=runsc', '--security-opt=label=disable'];
	return [`--runtime=${runtime}`];
}

export interface JobContainerArgsInput {
	podmanPath: string;
	request: PipelineJobStartRequest;
	paths: PipelineJobPaths;
	/** Per-job network when the job has services; null uses Podman's default network. */
	network: string | null;
	stepBinary: string;
	/** Read-only `buildctl` bind, when BuildKit is on. */
	buildctl: string | null;
	fuse: boolean;
	apparmorProfile: string | null;
}

/**
 * `podman run -d` for the job container. The step runner is bind-mounted read-only and is the only
 * process Podman starts; `--init` reaps zombies and forwards SIGTERM to it. Not `--rm`: the exit
 * code must outlive the container until `cleanup`.
 *
 * `default` drops every capability. `oci-build` (buildah `--isolation chroot` inside, WS2) keeps
 * Podman's default capability set, which is confined to the job's own user namespace, plus
 * /dev/fuse when the host has it. Both run with `no-new-privileges`.
 */
export function renderJobContainerArgs(input: JobContainerArgsInput): string[] {
	const { request, paths } = input;
	const id = request.jobId;
	const p = PIPELINE_CONTAINER_PATHS;
	const profile =
		request.profile === 'oci-build' ? (input.fuse ? ['--device=/dev/fuse'] : []) : ['--cap-drop=all'];
	return [
		input.podmanPath,
		'run',
		'-d',
		`--name=${jobContainerName(id)}`,
		`--label=${PIPELINE_JOB_LABEL}=${id}`,
		'--init',
		'--pull=never',
		...runtimeArgs(request.runtime),
		'--userns=auto:size=65536',
		...profile,
		'--security-opt=no-new-privileges',
		...(input.apparmorProfile ? [`--security-opt=apparmor=${input.apparmorProfile}`] : []),
		'--pids-limit=4096',
		`--memory=${request.memoryMb}m`,
		`--memory-swap=${request.memoryMb}m`,
		`--cpus=${request.cpus}`,
		...(input.network ? [`--network=${input.network}`] : []),
		'--log-driver=k8s-file',
		`--log-opt=path=${paths.runnerLog}`,
		'--log-opt=max-size=10mb',
		`--env-file=${paths.envFile}`,
		`--volume=${paths.workspace}:${p.workspace}:Z,U`,
		`--volume=${paths.meta}:${p.meta}:ro,Z,U`,
		`--volume=${paths.home}:${p.home}:Z,U`,
		`--volume=${paths.tmp}:${p.tmp}:Z,U`,
		`--volume=${input.stepBinary}:${p.stepBinary}:ro,z`,
		...(input.buildctl
			? [`--volume=${input.buildctl}:${p.buildctl}:ro,z`, `--volume=${paths.buildkitSocketDir}:${p.buildkitDir}:ro,z`]
			: []),
		`--workdir=${p.workspace}`,
		`--entrypoint=${p.stepBinary}`,
		request.image,
		'pipeline-step',
		p.jobFile,
	];
}

export interface ServiceArgsInput {
	podmanPath: string;
	request: PipelineJobStartRequest;
	service: PipelineServiceSpec;
	paths: PipelineJobPaths;
	network: string;
	apparmorProfile: string | null;
}

/**
 * `podman run -d` for a service (postgres, redis…). Databases chown their data directories on
 * start, so services keep Podman's default capabilities; they are still confined to their own
 * user namespace, cannot gain privileges, and run under the job's OCI runtime.
 */
export function renderServiceArgs(input: ServiceArgsInput): string[] {
	const { request, service, paths } = input;
	return [
		input.podmanPath,
		'run',
		'-d',
		`--name=${serviceContainerName(request.jobId, service.name)}`,
		`--label=${PIPELINE_JOB_LABEL}=${request.jobId}`,
		'--pull=never',
		...runtimeArgs(request.runtime),
		'--userns=auto:size=65536',
		'--security-opt=no-new-privileges',
		...(input.apparmorProfile ? [`--security-opt=apparmor=${input.apparmorProfile}`] : []),
		'--pids-limit=4096',
		`--memory=${request.memoryMb}m`,
		`--network=${input.network}`,
		...service.aliases.map((alias) => `--network-alias=${alias}`),
		'--log-driver=k8s-file',
		`--log-opt=path=${serviceLogFile(paths, service.name)}`,
		'--log-opt=max-size=5mb',
		`--env-file=${serviceEnvFile(paths, service.name)}`,
		...(service.healthCmd ? [`--health-cmd=${service.healthCmd}`, '--health-interval=disable'] : []),
		service.image,
	];
}

export interface BuildkitArgsInput {
	podmanPath: string;
	request: PipelineJobStartRequest;
	paths: PipelineJobPaths;
	cacheDir: string;
	fuse: boolean;
}

/**
 * The rootless BuildKit sidecar (W6, WS1 profile). It has its own user namespace (165 536 ids for
 * rootlesskit's nested one), seccomp, AppArmor, SELinux labelling and the masked /proc paths turned off so buildkitd
 * can create its own process sandbox for each `RUN` — never `--oci-worker-no-process-sandbox`,
 * which would run build steps in buildkitd's own namespaces. No `no-new-privileges`: rootlesskit's
 * `newuidmap` needs its file capabilities. Its only host mounts are its scoped cache directory and
 * the socket directory it shares with the job container. Always the node's default OCI runtime.
 */
export function renderBuildkitArgs(input: BuildkitArgsInput): string[] {
	const { request, paths } = input;
	return [
		input.podmanPath,
		'run',
		'-d',
		`--name=${buildkitContainerName(request.jobId)}`,
		`--label=${PIPELINE_JOB_LABEL}=${request.jobId}`,
		'--pull=never',
		`--userns=auto:size=${BUILDKIT.usernsSize}`,
		'--security-opt=seccomp=unconfined',
		'--security-opt=apparmor=unconfined',
		'--security-opt=unmask=ALL',
		// SELinux hosts: container_t may not mount a fresh procfs for each RUN (WS1: "error mounting
		// proc ... permission denied"); a no-op where AppArmor is the LSM.
		'--security-opt=label=disable',
		...(input.fuse ? ['--device=/dev/fuse'] : []),
		'--pids-limit=8192',
		`--memory=${request.memoryMb}m`,
		`--cpus=${request.cpus}`,
		'--log-driver=k8s-file',
		`--log-opt=path=${join(paths.runtime, 'buildkit.log')}`,
		'--log-opt=max-size=5mb',
		`--volume=${input.cacheDir}:${BUILDKIT.stateDir}:Z,U`,
		`--volume=${paths.buildkitSocketDir}:${PIPELINE_CONTAINER_PATHS.buildkitDir}:z,U`,
		BUILDKIT.image,
		`--addr=${BUILDKIT_HOST}`,
	];
}

/** `PATH=/skiff/bin:<the image's PATH>`, so `buildctl` and `skiff-step` resolve without hiding the image's tools. */
export function jobPath(imageEnv: readonly string[] | null | undefined): string {
	const path = imageEnv?.find((entry) => entry.startsWith('PATH='))?.slice(5) || DEFAULT_PATH;
	return `${PIPELINE_CONTAINER_PATHS.bin}:${path}`;
}

/** The helper's fixed variables, after the request's own. */
export function jobEnv(request: PipelineJobStartRequest, imagePath: string): Array<[string, string]> {
	const p = PIPELINE_CONTAINER_PATHS;
	return [
		...request.env,
		['HOME', p.home],
		['PATH', imagePath],
		['SKIFF_PIPELINE_WORKSPACE', p.workspace],
		['SKIFF_PIPELINE_TEMP', p.tmp],
		...(request.buildkit ? ([['BUILDKIT_HOST', BUILDKIT_HOST], ['SKIFF_BUILDCTL', p.buildctl]] as Array<[string, string]>) : []),
	];
}

// -------------------------------------------------------------------- capabilities

export interface PipelineCapabilities {
	/** Podman's version, or null when Podman does not answer. */
	podman: string | null;
	/** OCI runtimes a job may ask for: `runc` (the default runtime) always when Podman works. */
	runtimes: PipelineRuntime[];
	/** The `containers` subuid/subgid range for `--userns=auto` is in place. */
	userns: boolean;
	fuse: boolean;
	kvm: boolean;
	/** The step runner (the node's agent binary) exists. */
	stepBinary: boolean;
	/** The Builder's build directory as the helper sees it; job directories must live under it. */
	buildsRoot: string;
	buildkit: { version: string; image: string };
}

export interface CapabilityProbe {
	run(argv: string[]): Promise<RunResult>;
	exists(path: string): Promise<boolean>;
	ensureSubids(): Promise<boolean>;
}

export async function detectPipelineCapabilities(input: {
	probe: CapabilityProbe;
	podmanPath: string;
	stepBinary: string;
	buildsRoot: string;
}): Promise<PipelineCapabilities> {
	const { probe } = input;
	const version = await probe.run([input.podmanPath, 'version', '--format', '{{.Client.Version}}']).catch(() => null);
	const podman = version && version.code === 0 && /^\d+\.\d+/.test(version.stdout.trim()) ? version.stdout.trim().slice(0, 32) : null;
	const anyExists = async (paths: string[]) => (await Promise.all(paths.map((path) => probe.exists(path)))).some(Boolean);
	const kvm = await probe.exists('/dev/kvm');
	const runtimes: PipelineRuntime[] = [];
	if (podman) {
		runtimes.push('runc');
		if (await anyExists(RUNTIME_PATHS.runsc)) runtimes.push('runsc');
		// kata needs hardware virtualization; containerd-shim-kata-v2 alone is not a Podman runtime.
		if (kvm && (await anyExists(RUNTIME_PATHS.kata))) runtimes.push('kata');
	}
	const userns = await probe.ensureSubids().then(
		() => true,
		() => false,
	);
	return {
		podman,
		runtimes,
		userns,
		fuse: await probe.exists('/dev/fuse'),
		kvm,
		stepBinary: await probe.exists(input.stepBinary),
		buildsRoot: input.buildsRoot,
		buildkit: { version: BUILDKIT.version, image: BUILDKIT.image },
	};
}

// -------------------------------------------------------------------- status

export type PipelineJobState = 'starting' | 'running' | 'exited' | 'failed' | 'not-found';

export interface PipelineJobStatus {
	jobId: string;
	state: PipelineJobState;
	/** The step runner's exit code once `exited`. */
	exitCode: number | null;
	oomKilled: boolean;
	/** Why the job could not start (`failed`). Names images and services, never env values. */
	error: string | null;
	/** Progress lines for the job log: pulls, services, BuildKit. */
	events: string[];
}

/** `podman container inspect --format '{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}'`. */
export function parseInspectState(stdout: string): { state: 'running' | 'exited'; exitCode: number | null; oomKilled: boolean } | null {
	const [status, code, oom] = stdout.trim().split('|');
	if (!status) return null;
	if (status === 'exited' || status === 'stopped') {
		const exitCode = Number(code);
		return { state: 'exited', exitCode: Number.isInteger(exitCode) ? exitCode : null, oomKilled: oom === 'true' };
	}
	return { state: 'running', exitCode: null, oomKilled: false };
}

// -------------------------------------------------------------------- driver

export interface PipelineJobApi {
	capabilities(): Promise<PipelineCapabilities>;
	start(request: PipelineJobStartRequest): Promise<PipelineJobStatus>;
	status(jobId: string): Promise<PipelineJobStatus>;
	stop(jobId: string, options?: { force?: boolean }): Promise<void>;
	cleanup(jobId: string): Promise<void>;
	list(): Promise<string[]>;
}

export interface PipelineJobDriverOptions {
	runner: CommandRunner;
	podmanPath: string;
	/** `/run/skiff-workloads`: per-job env files live under `<runtimeDir>/pipeline-jobs`. */
	runtimeDir: string;
	/** Resolved on every call: storage relocation (D48) can move the Builder's directory. */
	buildsRoot: () => Promise<string>;
	/** The node's agent binary (`skiff-agent pipeline-step`); copied, never mounted in place. */
	stepBinary: string;
	apparmorProfile?: string | null;
	subidFiles?: SubidFiles;
	exists?: (path: string) => Promise<boolean>;
	sleep?: (ms: number) => Promise<void>;
	log?: (level: 'info' | 'warn', message: string) => void;
}

interface JobRecord {
	state: 'starting' | 'started' | 'failed';
	error: string | null;
	events: string[];
	cancelled: boolean;
	launch: Promise<void> | null;
	cacheDir: string | null;
}

const realExists = (path: string) => fs.stat(path).then(
	() => true,
	() => false,
);

export class PipelineJobDriver implements PipelineJobApi {
	private readonly jobs = new Map<string, JobRecord>();
	/** Cache directories in use: one buildkitd per state directory (it holds a bolt lock). */
	private readonly cachesInUse = new Set<string>();
	private readonly exists: (path: string) => Promise<boolean>;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(private readonly options: PipelineJobDriverOptions) {
		this.exists = options.exists ?? realExists;
		this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
	}

	private podman(args: string[]): Promise<RunResult> {
		return this.options.runner.run([this.options.podmanPath, ...args]);
	}

	async capabilities(): Promise<PipelineCapabilities> {
		return detectPipelineCapabilities({
			probe: {
				run: (argv) => this.options.runner.run(argv),
				exists: this.exists,
				ensureSubids: () => ensureContainerSubids(this.options.subidFiles),
			},
			podmanPath: this.options.podmanPath,
			stepBinary: this.options.stepBinary,
			buildsRoot: await this.options.buildsRoot(),
		});
	}

	async start(request: PipelineJobStartRequest): Promise<PipelineJobStatus> {
		const existing = await this.status(request.jobId);
		// Idempotent: a Builder that restarted mid-start asks again and gets the same job.
		if (existing.state !== 'not-found') return existing;
		if (this.jobs.size >= PIPELINE_MAX_LIVE) throw new ValidationError(`This node already holds ${PIPELINE_MAX_LIVE} pipeline jobs`);
		if (request.runtime !== 'runc') {
			const caps = await this.capabilities();
			if (!caps.runtimes.includes(request.runtime))
				throw new ValidationError(`The ${request.runtime} runtime is not available on this node (have: ${caps.runtimes.join(', ') || 'none'})`);
		}
		const buildsRoot = await this.options.buildsRoot();
		const paths = pipelineJobPaths(buildsRoot, this.options.runtimeDir, request.jobId);
		await this.checkJobDirs(buildsRoot, paths);

		await fs.mkdir(join(this.options.runtimeDir, 'pipeline-jobs'), { recursive: true, mode: 0o700 });
		await fs.rm(paths.runtime, { recursive: true, force: true });
		await fs.mkdir(paths.runtime, { mode: 0o700 });
		// The env files are written now, so the values (job token, service passwords) live only in
		// 0400 files from here on; the job env file gets PATH after the image is pulled.
		for (const service of request.services) await writeSecretFile(serviceEnvFile(paths, service.name), renderEnvFile(service.env));

		const record: JobRecord = { state: 'starting', error: null, events: [], cancelled: false, launch: null, cacheDir: null };
		this.jobs.set(request.jobId, record);
		record.launch = this.launch(request, paths, buildsRoot, record).then(
			() => {
				record.state = 'started';
			},
			(error: unknown) => {
				record.state = 'failed';
				record.error = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
				this.options.log?.('warn', `pipeline job ${request.jobId} did not start: ${record.error}`);
			},
		);
		return this.snapshot(request.jobId, record);
	}

	async status(jobId: string): Promise<PipelineJobStatus> {
		assertPipelineJobId(jobId);
		const record = this.jobs.get(jobId);
		if (record && record.state !== 'started') return this.snapshot(jobId, record);
		const inspect = await this.podman(['container', 'inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}', jobContainerName(jobId)]);
		const parsed = inspect.code === 0 ? parseInspectState(inspect.stdout) : null;
		if (!parsed) {
			// Started and gone: removed behind the helper's back. Unknown and gone: never started.
			if (record) return { ...this.snapshot(jobId, record), state: 'failed', error: 'The job container disappeared' };
			return { jobId, state: 'not-found', exitCode: null, oomKilled: false, error: null, events: [] };
		}
		return { jobId, ...parsed, error: null, events: record?.events.slice() ?? [] };
	}

	/** SIGTERM to the step runner (through `--init`), or SIGKILL with `force`. A start in progress is abandoned. */
	async stop(jobId: string, options: { force?: boolean } = {}): Promise<void> {
		assertPipelineJobId(jobId);
		const record = this.jobs.get(jobId);
		if (record) record.cancelled = true;
		const signal = options.force ? 'SIGKILL' : 'SIGTERM';
		const result = await this.podman(['kill', `--signal=${signal}`, jobContainerName(jobId)]);
		if (result.code !== 0 && !/no such container|not running|no container with name|is not running|does not exist/i.test(`${result.stderr}${result.stdout}`))
			throw new Error(`podman kill ${jobContainerName(jobId)} failed (${result.code}): ${detail(result)}`);
	}

	/** Remove the job's containers, network, env files and BuildKit socket. Idempotent; never the workspace. */
	async cleanup(jobId: string): Promise<void> {
		assertPipelineJobId(jobId);
		const record = this.jobs.get(jobId);
		if (record) {
			record.cancelled = true;
			// A launch in progress stops at its next step; wait so it cannot recreate what is removed.
			await Promise.race([record.launch, this.sleep(30_000)]).catch(() => undefined);
		}
		const listed = await this.podman(['ps', '-a', '--filter', `label=${PIPELINE_JOB_LABEL}=${jobId}`, '--format', '{{.Names}}']);
		const names = new Set([jobContainerName(jobId), ...listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)]);
		await this.podman(['rm', '--force', '--ignore', '--time=5', ...names]);
		await this.podman(['network', 'rm', '--force', jobNetworkName(jobId)]);
		await fs.rm(join(this.options.runtimeDir, 'pipeline-jobs', jobId), { recursive: true, force: true });
		if (record?.cacheDir) {
			this.cachesInUse.delete(record.cacheDir);
			// A job's private cache (no scope, or its scope was busy) dies with the job.
			if (record.cacheDir.endsWith(`/buildkit-cache/job-${jobId}`)) await fs.rm(record.cacheDir, { recursive: true, force: true }).catch(() => undefined);
		}
		this.jobs.delete(jobId);
	}

	/** Jobs with containers on this node, known to this helper or not (for the Builder's orphan reaping). */
	async list(): Promise<string[]> {
		const listed = await this.podman(['ps', '-a', '--filter', `label=${PIPELINE_JOB_LABEL}`, '--format', `{{index .Labels "${PIPELINE_JOB_LABEL}"}}`]);
		const ids = new Set(this.jobs.keys());
		for (const line of listed.stdout.split('\n')) if (PIPELINE_JOB_ID_PATTERN.test(line.trim())) ids.add(line.trim());
		return [...ids].sort();
	}

	private snapshot(jobId: string, record: JobRecord): PipelineJobStatus {
		return {
			jobId,
			state: record.state === 'failed' ? 'failed' : 'starting',
			exitCode: null,
			oomKilled: false,
			error: record.error,
			events: record.events.slice(),
		};
	}

	/** The Builder made these: they must be real directories under a root-owned, private job root. */
	private async checkJobDirs(buildsRoot: string, paths: PipelineJobPaths): Promise<void> {
		const root = await fs.lstat(paths.jobRoot).catch(() => null);
		if (!root || !root.isDirectory() || root.isSymbolicLink())
			throw new ValidationError(`The job directory ${paths.jobRoot} does not exist; the Builder creates it before starting the job`);
		// Root in production; the helper's own user in tests.
		const owner = typeof process.getuid === 'function' ? process.getuid() : 0;
		if (root.uid !== owner || (root.mode & 0o022) !== 0)
			throw new ValidationError(`The job directory ${paths.jobRoot} must be owned by root and not group- or world-writable`);
		if ((await fs.realpath(paths.jobRoot)) !== join(await fs.realpath(buildsRoot), 'pipelines', paths.jobRoot.split('/').pop()!))
			throw new ValidationError(`The job directory ${paths.jobRoot} must not be reached through a symlink`);
		for (const dir of [paths.workspace, paths.home, paths.tmp, paths.meta]) {
			const stat = await fs.lstat(dir).catch(() => null);
			if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new ValidationError(`${dir} must be a directory`);
		}
	}

	private event(record: JobRecord, message: string): void {
		record.events.push(message);
		if (record.events.length > EVENT_LIMIT) record.events.splice(0, record.events.length - EVENT_LIMIT);
	}

	private checkCancelled(record: JobRecord): void {
		if (record.cancelled) throw new Error('The job was stopped before its container started');
	}

	private async launch(request: PipelineJobStartRequest, paths: PipelineJobPaths, buildsRoot: string, record: JobRecord): Promise<void> {
		await ensureContainerSubids(this.options.subidFiles);
		const fuse = await this.exists('/dev/fuse');
		const apparmor = this.options.apparmorProfile ?? null;

		await this.pull(request.image, record, 'newer');
		for (const service of request.services) await this.pull(service.image, record, 'newer');
		if (request.buildkit) await this.pull(BUILDKIT.image, record, 'missing');
		this.checkCancelled(record);

		const stepBinary = await this.copyStepBinary(buildsRoot);
		let network: string | null = null;
		if (request.services.length) {
			network = jobNetworkName(request.jobId);
			const created = await this.podman(['network', 'create', `--label=${PIPELINE_JOB_LABEL}=${request.jobId}`, network]);
			if (created.code !== 0 && !/already exists/i.test(created.stderr)) throw new Error(`Could not create the job network: ${detail(created)}`);
			for (const service of request.services) {
				this.checkCancelled(record);
				this.event(record, `Starting service ${service.name} (${service.image})`);
				const argv = renderServiceArgs({ podmanPath: this.options.podmanPath, request, service, paths, network, apparmorProfile: apparmor });
				const started = await this.options.runner.run(argv);
				if (started.code !== 0) throw new Error(`Service ${service.name} did not start: ${detail(started)}`);
				await this.waitHealthy(request.jobId, service, record);
			}
		}

		let buildctl: string | null = null;
		if (request.buildkit) {
			this.checkCancelled(record);
			buildctl = await this.startBuildkit(request, paths, buildsRoot, fuse, record);
		}

		this.checkCancelled(record);
		const inspect = await this.podman(['image', 'inspect', '--format', '{{json .Config.Env}}', request.image]);
		let imageEnv: string[] = [];
		try {
			const parsed = JSON.parse(inspect.stdout.trim() || 'null') as unknown;
			if (Array.isArray(parsed)) imageEnv = parsed.filter((entry): entry is string => typeof entry === 'string');
		} catch {
			// No usable env: the default PATH applies.
		}
		await writeSecretFile(paths.envFile, renderEnvFile(jobEnv(request, jobPath(imageEnv))));
		await fs.rm(paths.runnerLog, { force: true });
		const argv = renderJobContainerArgs({
			podmanPath: this.options.podmanPath,
			request,
			paths,
			network,
			stepBinary,
			buildctl,
			fuse,
			apparmorProfile: apparmor,
		});
		this.checkCancelled(record);
		const started = await this.options.runner.run(argv);
		if (started.code !== 0) throw new Error(`The job container did not start: ${detail(started)}`);
		this.event(record, `Job container started${request.runtime === 'runc' ? '' : ` (runtime ${request.runtime})`}`);
	}

	private async pull(image: string, record: JobRecord, policy: 'newer' | 'missing'): Promise<void> {
		if (policy === 'missing' && (await this.podman(['image', 'exists', image])).code === 0) return;
		const started = Date.now();
		const pulled = await this.podman(['pull', '--quiet', image]);
		if (pulled.code !== 0) {
			// `newer` keeps working offline with a cached tag, like `--pull=newer`.
			if (policy === 'newer' && (await this.podman(['image', 'exists', image])).code === 0) {
				this.event(record, `Could not refresh ${image}; using the cached copy`);
				return;
			}
			throw new Error(`Could not pull ${image}: ${detail(pulled)}`);
		}
		this.event(record, `Pulled ${image} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
	}

	private async waitHealthy(jobId: string, service: PipelineServiceSpec, record: JobRecord): Promise<void> {
		const container = serviceContainerName(jobId, service.name);
		const deadline = Date.now() + SERVICE_HEALTH_TIMEOUT_MS;
		const running = async () =>
			(await this.podman(['container', 'inspect', '--format', '{{.State.Running}}', container])).stdout.trim() === 'true';
		while (Date.now() < deadline) {
			this.checkCancelled(record);
			const ok = service.healthCmd ? (await this.podman(['healthcheck', 'run', container])).code === 0 : await running();
			if (ok) {
				this.event(record, `Service ${service.name} is ${service.healthCmd ? 'healthy' : 'running'}`);
				return;
			}
			if (!(await running())) break;
			await this.sleep(2_000);
		}
		const tail = await this.podman(['logs', '--tail=30', container]);
		const lines = `${tail.stdout}${tail.stderr}`.trim().split('\n').slice(-30).join('\n');
		throw new Error(
			`Service ${service.name} did not become ${service.healthCmd ? 'healthy' : 'ready'} within ${SERVICE_HEALTH_TIMEOUT_MS / 1000}s` +
				(lines ? `; last output:\n${lines.slice(-3000)}` : ''),
		);
	}

	/**
	 * A per-job copy of the node's agent binary: the release link can switch under a running job,
	 * and a bind mount with a SELinux relabel must never touch the real binary. Keyed by size and
	 * mtime, so an update makes a new copy and old ones are pruned.
	 */
	private async copyStepBinary(buildsRoot: string): Promise<string> {
		const source = await fs.realpath(this.options.stepBinary).catch(() => null);
		const stat = source ? await fs.stat(source).catch(() => null) : null;
		if (!source || !stat?.isFile()) throw new Error(`The step runner ${this.options.stepBinary} is missing on this node`);
		const tools = join(buildsRoot, 'tools');
		const name = `skiff-step-${stat.size}-${Math.floor(stat.mtimeMs)}`;
		const target = join(tools, name);
		if (await this.exists(target)) return target;
		await fs.mkdir(tools, { recursive: true, mode: 0o755 });
		const temp = join(tools, `.${name}.${randomUUID()}`);
		await fs.copyFile(source, temp);
		await fs.chmod(temp, 0o755);
		await fs.rename(temp, target);
		for (const entry of await fs.readdir(tools))
			if (entry.startsWith('skiff-step-') && entry !== name) await fs.rm(join(tools, entry), { force: true }).catch(() => undefined);
		return target;
	}

	/** `buildctl` from the pinned image, copied out once per BuildKit version. */
	private async buildctlBinary(buildsRoot: string): Promise<string> {
		const tools = join(buildsRoot, 'tools');
		const target = join(tools, `buildctl-${BUILDKIT.version}`);
		if (await this.exists(target)) return target;
		await fs.mkdir(tools, { recursive: true, mode: 0o755 });
		const name = `skiff-buildctl-copy-${randomUUID().slice(0, 8)}`;
		const created = await this.podman(['create', '--pull=never', `--name=${name}`, BUILDKIT.image]);
		if (created.code !== 0) throw new Error(`Could not prepare buildctl: ${detail(created)}`);
		const temp = join(tools, `.buildctl.${randomUUID()}`);
		try {
			const copied = await this.podman(['cp', `${name}:${BUILDKIT.buildctlInImage}`, temp]);
			if (copied.code !== 0) throw new Error(`Could not copy buildctl out of ${BUILDKIT.image}: ${detail(copied)}`);
			await fs.chown(temp, 0, 0).catch(() => undefined);
			await fs.chmod(temp, 0o755);
			await fs.rename(temp, target);
		} finally {
			await this.podman(['rm', '--force', '--ignore', name]);
			await fs.rm(temp, { force: true }).catch(() => undefined);
		}
		return target;
	}

	private async startBuildkit(
		request: PipelineJobStartRequest,
		paths: PipelineJobPaths,
		buildsRoot: string,
		fuse: boolean,
		record: JobRecord,
	): Promise<string> {
		const buildctl = await this.buildctlBinary(buildsRoot);
		let cacheDir = buildkitCacheDir(buildsRoot, request.buildkitCacheScope, request.jobId);
		if (this.cachesInUse.has(cacheDir)) {
			// Another job of this scope holds the cache; build without it rather than wait.
			this.event(record, 'The BuildKit cache for this scope is in use by another job; building without it');
			cacheDir = buildkitCacheDir(buildsRoot, null, request.jobId);
		}
		this.cachesInUse.add(cacheDir);
		record.cacheDir = cacheDir;
		await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
		await fs.mkdir(paths.buildkitSocketDir, { mode: 0o711 });
		const started = Date.now();
		const run = await this.options.runner.run(
			renderBuildkitArgs({ podmanPath: this.options.podmanPath, request, paths, cacheDir, fuse }),
		);
		if (run.code !== 0) throw new Error(`BuildKit did not start: ${detail(run)}`);
		const socket = join(paths.buildkitSocketDir, BUILDKIT.socketName);
		const container = buildkitContainerName(request.jobId);
		const deadline = Date.now() + BUILDKIT_READY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			this.checkCancelled(record);
			const stat = await fs.stat(socket).catch(() => null);
			if (stat?.isSocket()) {
				// The socket belongs to BuildKit's namespace; the job runs in another one. Only these
				// two containers mount the directory, so the socket may be world-connectable.
				await fs.chmod(socket, 0o666);
				this.event(record, `BuildKit ${BUILDKIT.version} is ready (${((Date.now() - started) / 1000).toFixed(1)}s)`);
				return buildctl;
			}
			const state = await this.podman(['container', 'inspect', '--format', '{{.State.Running}}', container]);
			if (state.stdout.trim() !== 'true') break;
			await this.sleep(250);
		}
		const tail = await this.podman(['logs', '--tail=30', container]);
		throw new Error(`BuildKit did not become ready: ${`${tail.stdout}${tail.stderr}`.trim().slice(-3000) || 'no output'}`);
	}
}

async function writeSecretFile(path: string, content: string): Promise<void> {
	await fs.rm(path, { force: true });
	await fs.writeFile(path, content, { mode: 0o400, flag: 'wx' });
	await fs.chmod(path, 0o400);
}

function detail(result: RunResult): string {
	return (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).slice(0, 1000);
}

// -------------------------------------------------------------------- routes

/**
 * `/v1/pipeline/*`. Returns null for a path that is not one of these verbs. Validation errors
 * propagate as `ValidationError` (the server answers 400).
 */
export async function routePipelineRequest(
	api: PipelineJobApi,
	request: { method: string; path: string; search: string; readJson(): Promise<unknown>; readText(): Promise<string> },
): Promise<{ status: number; body: unknown; allow?: string } | null> {
	const { method, path } = request;
	const notAllowed = (allow: string) => ({ status: 405, body: { error: 'method_not_allowed' }, allow });
	if (path === '/v1/pipeline/capabilities') {
		if (method !== 'GET') return notAllowed('GET');
		return { status: 200, body: { ok: true, capabilities: await api.capabilities() } };
	}
	if (path === '/v1/pipeline/jobs') {
		if (method !== 'GET') return notAllowed('GET');
		return { status: 200, body: { ok: true, jobs: await api.list() } };
	}
	if (path === '/v1/pipeline/jobs/start') {
		if (method !== 'POST') return notAllowed('POST');
		if (request.search) throw new ValidationError('start takes no query parameters');
		return { status: 200, body: { ok: true, job: await api.start(parsePipelineJobStart(await request.readJson())) } };
	}
	const match = /^\/v1\/pipeline\/jobs\/([^/]+)(?:\/(stop|cleanup))?$/.exec(path);
	if (!match) return null;
	const jobId = assertPipelineJobId(match[1]);
	const verb = match[2];
	if (!verb) {
		if (method !== 'GET') return notAllowed('GET');
		return { status: 200, body: { ok: true, job: await api.status(jobId) } };
	}
	if (method !== 'POST') return notAllowed('POST');
	if (request.search) throw new ValidationError(`${verb} takes no query parameters`);
	const text = await request.readText();
	let body: Record<string, unknown> = {};
	if (text.trim()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new ValidationError('Request body must be valid JSON');
		}
		body = assertRecord(parsed, 'request');
	}
	if (verb === 'cleanup') {
		onlyKeys(body, [], 'request');
		await api.cleanup(jobId);
		return { status: 200, body: { ok: true, cleaned: jobId } };
	}
	onlyKeys(body, ['force'], 'request');
	if (body.force !== undefined && typeof body.force !== 'boolean') throw new ValidationError('force must be a boolean');
	await api.stop(jobId, { force: body.force === true });
	return { status: 200, body: { ok: true, stopped: jobId, force: body.force === true } };
}

/**
 * Builder configuration (D3). Everything comes from the environment so the compiled daemon can
 * be dropped into a systemd unit with an EnvironmentFile:
 *
 *   YOAL_CONTROL_URL   control-plane origin, no trailing slash
 *   YOAL_NODE_TOKEN    token for a node marked `can_build`
 *   YOAL_BUILD_DIR     scratch root for clones and artifacts
 *
 * Optional: `YOAL_GIT_TOKEN` for private HTTPS repositories (never logged), sent only to the
 * hosts in `YOAL_GIT_TOKEN_HOSTS` (comma-separated, default `github.com`); `YOAL_GIT_SSH_KEY`
 * (a root-only private key file) for SSH repository URLs, with an optional pinned
 * `YOAL_GIT_SSH_KNOWN_HOSTS`; and `YOAL_BUILDER_SYSTEMD=false` to force direct execution on a
 * development workstation.
 *
 * On a node, `yoal-builder.service` runs `yoal-agent builder` with the agent's own
 * `/etc/yoal/agent.env`, so every enrolled node can build once an admin turns the role on (D47).
 * Builds then run as `YOAL_BUILDER_USER` (default `yoal-build`) in a sandboxed transient unit.
 *
 * Pipelines (docs/PIPELINES.md) run from the same daemon: `YOAL_PIPELINES=false` turns them off;
 * `YOAL_PIPELINE_POLL_MS` (3000), `YOAL_PIPELINE_MAX_JOBS` (1), `YOAL_PIPELINE_LABELS` (extra
 * comma-separated labels), `YOAL_PIPELINE_ISOLATION` (`auto` default, `container`, or `sandbox`),
 * `YOAL_PIPELINE_CONTAINER_DRIVER` (`helper` default; `podman` runs Podman from this daemon, for
 * development only), `YOAL_HELPER_SOCKET` (yoal-helper's socket, as for the agent),
 * `YOAL_PIPELINE_STEP_BINARY` (a binary accepting `pipeline-step <job.json>`; not used through the helper),
 * `YOAL_PIPELINE_CONTROL_URL` (the control plane as a job container reaches it) and
 * `YOAL_PIPELINE_RUNNER_NAME` (`runner.name`, default the hostname) tune them.
 */

import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { isShellSafePath } from './command.ts';

/** Toolchains a build can find: Yoal's own Bun first, then the system's. */
export const DEFAULT_BUILD_PATH =
	'/opt/yoal/current/runtime/bin:/opt/yoal/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export interface BuilderConfig {
	controlUrl: string;
	nodeToken: string;
	buildDir: string;
	/**
	 * Credential for private HTTPS repositories. It is handed to `git clone` as an HTTP header in
	 * the clone's environment, never in the URL or `.git/config`, and only for `gitTokenHosts`.
	 */
	gitToken: string | null;
	/** Hosts (`host` or `host:port`) the git token may be sent to. */
	gitTokenHosts: string[];
	/**
	 * Deploy key for `ssh://` and `git@host:path` repositories, passed to the clone through
	 * `GIT_SSH_COMMAND` only. Null leaves SSH clones to whatever the daemon's ssh would do.
	 */
	gitSshKey: string | null;
	/** Pinned `known_hosts` for those clones; null records each host's key on first use. */
	gitSshKnownHosts: string | null;
	pollMs: number;
	/** Run each build in a transient systemd unit; false uses a direct child process. */
	systemd: boolean;
	timeoutSeconds: number;
	memoryMax: string;
	cpuQuota: string;
	/** Account each sandboxed build runs as; null runs as the daemon's own user (development). */
	buildUser: string | null;
	/** PATH inside the build. */
	buildPath: string;
	/** How long to wait before asking again while this node does not have the Builder role. */
	idlePollMs: number;
	/** Claim pipeline jobs as well as git builds (`YOAL_PIPELINES`, default on). */
	pipelinesEnabled: boolean;
	pipelinePollMs: number;
	/** Pipeline jobs run at once on this node. */
	pipelineMaxJobs: number;
	/** Operator labels added to the automatic os/arch/self-hosted ones. */
	pipelineLabels: string[];
	/**
	 * `container` (Podman, W5) or `sandbox` (systemd-run / direct, no `container:` or `services:`).
	 * With `pipelineIsolationMode: 'auto'` this is provisional until the pipeline loop has asked
	 * yoal-helper what it can do (`chooseIsolation`).
	 */
	pipelineIsolation: PipelineIsolation;
	/** What the operator asked for (`YOAL_PIPELINE_ISOLATION`, default `auto`). */
	pipelineIsolationMode: PipelineIsolationMode;
	/** Who runs Podman in `container` isolation: yoal-helper's fixed verbs, or (development) this daemon. */
	pipelineContainerDriver: 'helper' | 'podman';
	/** yoal-helper's control socket (`YOAL_HELPER_SOCKET`, the agent's default). */
	helperSocket: string;
	/** Explicit step-runner binary; null derives it from the running executable. */
	pipelineStepBinary: string | null;
	/**
	 * Control-plane URL as a job sees it (`YOAL_PIPELINE_CONTROL_URL`, default `controlUrl`). A
	 * container has its own network namespace, so a loopback URL that works for the daemon does not
	 * work from inside a job.
	 */
	pipelineControlUrl: string;
	/** `runner.name` in jobs (`YOAL_PIPELINE_RUNNER_NAME`, default the hostname). */
	pipelineRunnerName: string;
}

export type PipelineIsolation = 'container' | 'sandbox';
export type PipelineIsolationMode = PipelineIsolation | 'auto';

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigError';
	}
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new ConfigError(`Missing required environment variable ${name}`);
	return value;
}

function positiveInt(env: Env, name: string, fallback: number): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${name} must be a positive number`);
	return Math.floor(value);
}

function truthy(value: string | undefined, name = 'YOAL_BUILDER_SYSTEMD'): boolean | null {
	if (value === undefined || !value.trim()) return null;
	const normalized = value.trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	throw new ConfigError(`${name} must be true or false`);
}

/** What the host offers, for choosing pipeline isolation; injectable for tests. */
export interface HostProbe {
	platform: NodeJS.Platform;
	isRoot: boolean;
	has(binary: string): boolean;
	arch: string;
	exists(path: string): boolean;
}

export const hostProbe: HostProbe = {
	platform: process.platform,
	isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
	has: (binary) => Boolean(Bun.which(binary)),
	arch: process.arch,
	exists: (path) => existsSync(path),
};

/** `YOAL_PIPELINE_ISOLATION`: `container`, `sandbox`, or `auto` (the default). */
export function resolvePipelineIsolation(explicit: string | undefined): PipelineIsolationMode {
	const value = explicit?.trim().toLowerCase() || 'auto';
	if (value === 'container' || value === 'sandbox' || value === 'auto') return value;
	throw new ConfigError('YOAL_PIPELINE_ISOLATION must be container, sandbox or auto');
}

/** What yoal-helper's `GET /v1/pipeline/capabilities` reported (null: it did not answer). */
export interface HelperCapabilitiesLike {
	podman: string | null;
	runtimes: Array<'runc' | 'runsc' | 'kata'>;
	userns: boolean;
	stepBinary: boolean;
	buildsRoot: string;
}

export interface IsolationChoice {
	isolation: PipelineIsolation;
	/** OCI runtimes to offer in the claim (W14); empty for `sandbox`. */
	runtimes: Array<'runc' | 'runsc' | 'kata'>;
	/** Why, for the daemon's log. */
	reason: string;
}

/**
 * The effective isolation. Containers start through yoal-helper (W5), so they no longer need any
 * capability on the Builder unit: `auto` is `container` whenever the helper answers, Podman works,
 * the `containers` subuid range is in place, the step runner exists and the helper derives job
 * directories from this daemon's own build directory; otherwise `sandbox`. An explicit
 * `container` stays `container` (jobs then fail with the helper's reason). The development
 * `podman` driver keeps the old rule: Linux, root, Podman on PATH.
 */
export function chooseIsolation(input: {
	mode: PipelineIsolationMode;
	driver: 'helper' | 'podman';
	buildDir: string;
	caps: HelperCapabilitiesLike | null;
	capsError?: string | null;
	probe: Pick<HostProbe, 'platform' | 'isRoot' | 'has'>;
}): IsolationChoice {
	const { mode, caps } = input;
	if (mode === 'sandbox') return { isolation: 'sandbox', runtimes: [], reason: 'YOAL_PIPELINE_ISOLATION=sandbox' };
	if (input.driver === 'podman') {
		const podman = input.probe.platform === 'linux' && input.probe.isRoot && input.probe.has('podman');
		if (mode === 'container' || podman)
			return { isolation: 'container', runtimes: ['runc'], reason: 'Podman run by the Builder itself (YOAL_PIPELINE_CONTAINER_DRIVER=podman)' };
		return { isolation: 'sandbox', runtimes: [], reason: 'no rootful Podman for the podman driver' };
	}
	let problem: string | null = null;
	if (!caps) problem = `yoal-helper did not answer (${input.capsError ?? 'unreachable'})`;
	else if (!caps.podman) problem = 'yoal-helper reports no working Podman';
	else if (!caps.userns) problem = 'yoal-helper could not set up the containers subuid range';
	else if (!caps.stepBinary) problem = 'yoal-helper has no step runner (agent binary)';
	else if (caps.buildsRoot !== input.buildDir)
		problem = `yoal-helper puts job directories under ${caps.buildsRoot}, but this Builder uses ${input.buildDir}`;
	if (!problem) {
		const runtimes = caps!.runtimes.includes('runc') ? caps!.runtimes : (['runc', ...caps!.runtimes] as IsolationChoice['runtimes']);
		return { isolation: 'container', runtimes, reason: `yoal-helper with Podman ${caps!.podman}` };
	}
	if (mode === 'container') return { isolation: 'container', runtimes: caps?.runtimes.length ? caps.runtimes : ['runc'], reason: `explicit container, but ${problem}` };
	return { isolation: 'sandbox', runtimes: [], reason: problem };
}

const LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function pipelineLabelList(value: string | undefined): string[] {
	const labels = (value ?? '')
		.split(',')
		.map((label) => label.trim().toLowerCase())
		.filter(Boolean);
	for (const label of labels)
		if (!LABEL.test(label)) throw new ConfigError(`YOAL_PIPELINE_LABELS has an invalid label "${label.slice(0, 64)}"`);
	return labels;
}

/**
 * Labels this node offers when claiming: os, arch, `self-hosted`, `oci-build` when an image can be
 * built here, then the operator's own. `runs-on` must be a subset of these.
 */
export function pipelineNodeLabels(
	config: Pick<BuilderConfig, 'pipelineLabels' | 'pipelineIsolation'>,
	probe: Pick<HostProbe, 'platform' | 'arch' | 'has'> = hostProbe,
): string[] {
	const labels = [
		probe.platform === 'darwin' ? 'macos' : probe.platform,
		probe.arch === 'arm64' ? 'arm64' : 'x64',
		'self-hosted',
	];
	if (config.pipelineIsolation === 'container' || probe.has('buildah') || probe.has('buildctl')) labels.push('oci-build');
	return [...new Set([...labels, ...config.pipelineLabels])].slice(0, 64);
}

/** Default: the token is for GitHub, and a repo URL elsewhere must never receive it. */
export const DEFAULT_GIT_TOKEN_HOSTS = ['github.com'];

function gitTokenHosts(value: string | undefined): string[] {
	if (value === undefined || !value.trim()) return DEFAULT_GIT_TOKEN_HOSTS;
	const hosts = value
		.split(',')
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean);
	for (const host of hosts)
		if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(host))
			throw new ConfigError(`YOAL_GIT_TOKEN_HOSTS has an invalid host "${host}"`);
	return hosts;
}

/** An optional absolute file path that is safe to put, single-quoted, in `GIT_SSH_COMMAND`. */
function sshPath(env: Env, name: string): string | null {
	const value = env[name]?.trim();
	if (!value) return null;
	if (!isShellSafePath(value))
		throw new ConfigError(`${name} must be an absolute path using only letters, digits and . _ / @ + -`);
	return value;
}

export function loadConfig(env: Env = process.env, probe: HostProbe = hostProbe): BuilderConfig {
	const controlUrl = required(env, 'YOAL_CONTROL_URL').replace(/\/+$/, '');
	let parsed: URL;
	try {
		parsed = new URL(controlUrl);
	} catch {
		throw new ConfigError('YOAL_CONTROL_URL must be an absolute URL');
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
		throw new ConfigError('YOAL_CONTROL_URL must use http or https');

	const explicitSystemd = truthy(env.YOAL_BUILDER_SYSTEMD);
	const available = process.platform === 'linux' && Boolean(Bun.which('systemd-run'));
	const systemd = explicitSystemd ?? available;
	const rawUser = env.YOAL_BUILDER_USER?.trim();
	const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
	// Only root can start a unit as another user; never run user code as root by default.
	const buildUser =
		rawUser === 'none' || rawUser === '' ? null : rawUser ?? (systemd && isRoot ? 'yoal-build' : null);
	if (buildUser && !/^[a-z_][a-z0-9_-]{0,31}$/.test(buildUser))
		throw new ConfigError('YOAL_BUILDER_USER must be a plain system user name');
	if (buildUser && !systemd) throw new ConfigError('YOAL_BUILDER_USER needs systemd-run (YOAL_BUILDER_SYSTEMD)');
	if (isRoot && !buildUser)
		throw new ConfigError('Refusing to run builds as root; set YOAL_BUILDER_USER and enable systemd-run');
	return {
		controlUrl,
		nodeToken: required(env, 'YOAL_NODE_TOKEN'),
		buildDir: required(env, 'YOAL_BUILD_DIR'),
		gitToken: env.YOAL_GIT_TOKEN?.trim() || null,
		gitTokenHosts: gitTokenHosts(env.YOAL_GIT_TOKEN_HOSTS),
		gitSshKey: sshPath(env, 'YOAL_GIT_SSH_KEY'),
		gitSshKnownHosts: sshPath(env, 'YOAL_GIT_SSH_KNOWN_HOSTS'),
		pollMs: positiveInt(env, 'YOAL_BUILDER_POLL_MS', 5_000),
		systemd,
		timeoutSeconds: positiveInt(env, 'YOAL_BUILDER_TIMEOUT_SECONDS', 600),
		memoryMax: env.YOAL_BUILDER_MEMORY_MAX?.trim() || '2G',
		cpuQuota: env.YOAL_BUILDER_CPU_QUOTA?.trim() || '200%',
		buildUser,
		buildPath: env.YOAL_BUILDER_PATH?.trim() || DEFAULT_BUILD_PATH,
		idlePollMs: positiveInt(env, 'YOAL_BUILDER_IDLE_POLL_MS', 30_000),
		pipelinesEnabled: truthy(env.YOAL_PIPELINES, 'YOAL_PIPELINES') ?? true,
		pipelinePollMs: positiveInt(env, 'YOAL_PIPELINE_POLL_MS', 3_000),
		pipelineMaxJobs: Math.min(positiveInt(env, 'YOAL_PIPELINE_MAX_JOBS', 1), 64),
		pipelineLabels: pipelineLabelList(env.YOAL_PIPELINE_LABELS),
		pipelineIsolation: resolvePipelineIsolation(env.YOAL_PIPELINE_ISOLATION) === 'container' ? 'container' : 'sandbox',
		pipelineIsolationMode: resolvePipelineIsolation(env.YOAL_PIPELINE_ISOLATION),
		pipelineContainerDriver: containerDriver(env.YOAL_PIPELINE_CONTAINER_DRIVER),
		helperSocket: helperSocket(env.YOAL_HELPER_SOCKET),
		pipelineStepBinary: stepBinary(env.YOAL_PIPELINE_STEP_BINARY),
		pipelineControlUrl: httpUrl(env.YOAL_PIPELINE_CONTROL_URL, 'YOAL_PIPELINE_CONTROL_URL') ?? controlUrl,
		pipelineRunnerName: env.YOAL_PIPELINE_RUNNER_NAME?.trim().slice(0, 100) || hostname(),
	};
}

function httpUrl(value: string | undefined, name: string): string | null {
	const raw = value?.trim().replace(/\/+$/, '');
	if (!raw) return null;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new ConfigError(`${name} must be an absolute URL`);
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new ConfigError(`${name} must use http or https`);
	return raw;
}

function stepBinary(value: string | undefined): string | null {
	const path = value?.trim();
	if (!path) return null;
	if (!isShellSafePath(path)) throw new ConfigError('YOAL_PIPELINE_STEP_BINARY must be an absolute path of plain characters');
	return path;
}

function containerDriver(value: string | undefined): 'helper' | 'podman' {
	const driver = value?.trim().toLowerCase() || 'helper';
	if (driver !== 'helper' && driver !== 'podman') throw new ConfigError('YOAL_PIPELINE_CONTAINER_DRIVER must be helper or podman');
	return driver;
}

function helperSocket(value: string | undefined): string {
	const path = value?.trim() || '/run/yoal-helper/helper.sock';
	if (!isShellSafePath(path)) throw new ConfigError('YOAL_HELPER_SOCKET must be an absolute path of plain characters');
	return path;
}

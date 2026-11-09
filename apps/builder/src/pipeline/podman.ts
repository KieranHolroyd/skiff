import type { PipelineContainerSpec } from '@yoal/contracts';
import { BuildValidationError } from '../command.ts';

/**
 * Pure Podman argv for pipeline job and service containers (W5). Every field that reaches argv
 * is validated here; there is never a shell, so a value can at worst be a wrong argument, never a
 * second command. Kept free of I/O so the exact flags are pinned by tests.
 */

/**
 * An OCI image reference: optional registry host[:port], lowercase path components, optional tag
 * and/or sha256 digest. Stricter than the distribution grammar on purpose (no leading `-`, no
 * whitespace, bounded length).
 */
const HOST_PART = '[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?';
const PORT = '(?::[0-9]{1,5})';
/** Like Docker: the first component is a registry only with a dot, a port, or `localhost`. */
const REGISTRY = `(?:localhost${PORT}?|${HOST_PART}(?:\\.${HOST_PART})+${PORT}?|${HOST_PART}${PORT})`;
const PATH_PART = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const IMAGE_REF = new RegExp(
	`^(?:${REGISTRY}/)?${PATH_PART}(?:/${PATH_PART})*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[a-f0-9]{64})?$`,
);

export function validateImageRef(image: string): string {
	const value = image.trim();
	if (!value || value.length > 512 || !IMAGE_REF.test(value)) throw new BuildValidationError(`Invalid image reference "${image.slice(0, 200)}"`);
	return value;
}

/**
 * Docker's short-name rules, made explicit: `postgres:17` → `docker.io/library/postgres:17`,
 * `acme/api` → `docker.io/acme/api`. Podman would otherwise consult registries.conf (and refuse
 * an ambiguous short name without a TTY).
 */
export function qualifyImageRef(image: string): string {
	const value = validateImageRef(image);
	const slash = value.indexOf('/');
	const first = slash < 0 ? '' : value.slice(0, slash);
	if (slash >= 0 && (first.includes('.') || first.includes(':') || first === 'localhost')) return value;
	return slash < 0 ? `docker.io/library/${value}` : `docker.io/${value}`;
}

/** Job ids become container, network and unit names. */
export function validateJobId(id: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) throw new BuildValidationError(`Invalid job id "${id.slice(0, 100)}"`);
	return id;
}

/** A service key becomes a DNS alias on the job network. */
export function validateServiceName(name: string): string {
	if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(name))
		throw new BuildValidationError(`Invalid service name "${name.slice(0, 100)}": use letters, digits and dashes`);
	return name.toLowerCase();
}

/** Host paths that become `-v` sources: absolute, plain characters, no `:`/`,` (mount syntax). */
export function validateHostPath(path: string): string {
	if (!/^\/[A-Za-z0-9._/@+-]+$/.test(path) || path.split('/').includes('..'))
		throw new BuildValidationError(`Unsafe host path "${path.slice(0, 200)}"`);
	return path;
}

function validateEnvName(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new BuildValidationError(`Invalid environment variable name "${name.slice(0, 100)}"`);
	return name;
}

function envArgs(env: Record<string, string>): string[] {
	return Object.entries(env).flatMap(([name, value]) => {
		if (value.includes('\0')) throw new BuildValidationError(`Environment variable ${name} contains a NUL byte`);
		return ['-e', `${validateEnvName(name)}=${value}`];
	});
}

export const jobContainerName = (jobId: string) => `yoal-job-${validateJobId(jobId)}`;
export const jobNetworkName = (jobId: string) => `yoal-job-${validateJobId(jobId)}`;
export const serviceContainerName = (jobId: string, service: string) =>
	`yoal-job-${validateJobId(jobId)}-svc-${validateServiceName(service)}`;

/** Where things live inside the job container. */
export const CONTAINER_PATHS = {
	workspace: '/workspace',
	meta: '/yoal/meta',
	home: '/yoal/home',
	tmp: '/yoal/tmp',
	stepBinary: '/yoal/bin/yoal-step',
	jobFile: '/yoal/meta/job.json',
} as const;

export interface PodmanJobInput {
	jobId: string;
	image: string;
	dirs: { workspace: string; meta: string; home: string; tmp: string };
	stepBinary: string;
	memoryMb: number;
	cpus: number;
	/** Per-job network when the job has services; null uses Podman's default network. */
	network: string | null;
	/** `oci-build` jobs (buildah inside): default capabilities and /dev/fuse instead of none. */
	ociBuild: boolean;
	/** /dev/fuse exists on this host (only used for `oci-build`). */
	fuse: boolean;
	/** Literal variables (non-secret). */
	env: Record<string, string>;
	/** Variables copied from podman's own environment by name, so their values never sit in argv. */
	inheritEnv: string[];
}

/**
 * `podman run` for the job container. The step runner is bind-mounted read-only and is the only
 * process Podman starts; `--init` reaps zombies and forwards SIGTERM so a cancel reaches it.
 */
export function podmanJobArgs(input: PodmanJobInput): string[] {
	if (!Number.isFinite(input.memoryMb) || input.memoryMb < 64 || input.memoryMb > 1_048_576)
		throw new BuildValidationError('memoryMb must be between 64 and 1048576');
	if (!Number.isFinite(input.cpus) || input.cpus <= 0 || input.cpus > 1024) throw new BuildValidationError('cpus must be positive');
	const dirs = {
		workspace: validateHostPath(input.dirs.workspace),
		meta: validateHostPath(input.dirs.meta),
		home: validateHostPath(input.dirs.home),
		tmp: validateHostPath(input.dirs.tmp),
	};
	const isolation = input.ociBuild
		? // PENDING spike WS2 (docs/PIPELINES.md §10): buildah --isolation chroot inside the job needs
			// Podman's default capability set (SETUID/SETGID/SYS_CHROOT/…, all confined to the job's own
			// user namespace) and /dev/fuse for fuse-overlayfs. Revisit once WS1/WS2 pin the profile.
			[...(input.fuse ? ['--device', '/dev/fuse'] : [])]
		: ['--cap-drop=all'];
	return [
		'podman',
		'run',
		'--rm',
		'--init',
		`--name=${jobContainerName(input.jobId)}`,
		'--userns=auto',
		...isolation,
		'--security-opt=no-new-privileges',
		'--pids-limit=4096',
		`--memory=${Math.floor(input.memoryMb)}m`,
		`--cpus=${input.cpus}`,
		...(input.network ? [`--network=${input.network}`] : []),
		'-v',
		`${dirs.workspace}:${CONTAINER_PATHS.workspace}:U`,
		'-v',
		`${dirs.meta}:${CONTAINER_PATHS.meta}:U,ro`,
		'-v',
		`${dirs.home}:${CONTAINER_PATHS.home}:U`,
		'-v',
		`${dirs.tmp}:${CONTAINER_PATHS.tmp}:U`,
		'-v',
		`${validateHostPath(input.stepBinary)}:${CONTAINER_PATHS.stepBinary}:ro`,
		'-w',
		CONTAINER_PATHS.workspace,
		'-e',
		`HOME=${CONTAINER_PATHS.home}`,
		...envArgs(input.env),
		...input.inheritEnv.flatMap((name) => ['-e', validateEnvName(name)]),
		'--entrypoint',
		CONTAINER_PATHS.stepBinary,
		qualifyImageRef(input.image),
		'pipeline-step',
		CONTAINER_PATHS.jobFile,
	];
}

export interface PodmanServiceInput {
	jobId: string;
	name: string;
	spec: PipelineContainerSpec;
	/**
	 * The service's `env:` with templates already evaluated. Only the names reach argv (`-e NAME`);
	 * the caller passes the values in podman's own environment, because they may hold secrets.
	 */
	env: Record<string, string>;
	network: string;
	memoryMb: number;
}

/**
 * `podman run -d` for a service (postgres, redis…). Databases chown their data directories on
 * start, so services keep Podman's default capabilities; they are still confined to their own
 * user namespace and cannot gain privileges.
 */
export function podmanServiceArgs(input: PodmanServiceInput): string[] {
	const name = validateServiceName(input.name);
	return [
		'podman',
		'run',
		'-d',
		`--name=${serviceContainerName(input.jobId, name)}`,
		`--network=${input.network}`,
		`--network-alias=${name}`,
		'--userns=auto',
		'--security-opt=no-new-privileges',
		'--pids-limit=4096',
		`--memory=${Math.floor(input.memoryMb)}m`,
		...(input.spec.healthCmd ? ['--health-cmd', input.spec.healthCmd, '--health-interval=disable'] : []),
		...Object.keys(input.env).flatMap((name) => ['-e', validateEnvName(name)]),
		qualifyImageRef(input.spec.image),
	];
}

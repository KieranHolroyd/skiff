import * as z from 'zod';

/**
 * Container console (D127): inspect, files and an interactive shell for a project's own
 * container workload. Browser → control plane → internal gateway (D82/D96) → the agent's
 * console front on node loopback → the helper's fixed container verbs. The browser never sees
 * the console token; it lives only on the control-plane → node hop.
 */

/** Loopback port the agent's console front listens on, on every node that advertises it. */
export const CONTAINER_CONSOLE_DEFAULT_PORT = 8084;
/** Internal host suffix the gateway matches for a node's console front (never public DNS). */
export const CONTAINER_CONSOLE_GATEWAY_SUFFIX = 'console.internal';
/** Request header the control plane adds on the gateway hop. Never sent by a browser. */
export const CONTAINER_CONSOLE_TOKEN_HEADER = 'x-skiff-console-token';
/** Agents advertising this run the console front and the helper's container verbs. */
export const CONTAINER_CONSOLE_CAPABILITY = 'container-console';
export const CONTAINER_CONSOLE_PROTOCOL_VERSION = 1;
/** A console token is minted per control-plane call batch and lives this long. */
export const CONTAINER_CONSOLE_TOKEN_TTL_MS = 5 * 60_000;

export const containerConsoleLimits = {
	/** Shell sessions one container may hold open at once. */
	execPerContainer: 4,
	/** Shell sessions one node may hold open at once. */
	execPerNode: 32,
	/** A shell with no attached viewer and no input is closed after this long. */
	execIdleMs: 15 * 60_000,
	/** A shell is closed after this long whatever happens. */
	execMaxMs: 8 * 60 * 60_000,
	/** Output kept for a reconnecting viewer (`Last-Event-ID` replay). */
	execReplayBytes: 256 * 1024,
	/** One input POST. */
	execInputBytes: 64 * 1024,
	/** Entries one directory listing returns; the rest are reported as truncated. */
	listEntries: 2_000,
	/** Largest file the preview returns inline; downloads stream with no cap. */
	previewBytes: 1024 * 1024,
	/** Longest path accepted. */
	pathLength: 4_096,
} as const;

/** The gateway host for one node's console front. */
export function containerConsoleHost(nodeId: string): string {
	const label = nodeId.replace(/^node_/, '').toLowerCase().replace(/[^a-z0-9-]/g, '');
	return `n-${label}.${CONTAINER_CONSOLE_GATEWAY_SUFFIX}`;
}

export const containerConsoleScopes = ['inspect', 'files', 'exec'] as const;
export type ContainerConsoleScope = (typeof containerConsoleScopes)[number];

/** `GET /api/agent/container-console` (node bearer + console token): what the token allows. */
export const containerConsoleActivationSchema = z.object({
	v: z.literal(CONTAINER_CONSOLE_PROTOCOL_VERSION),
	/** The desired workload id on this node (`wld_…` or `wld_…-r<n>`); the only one usable. */
	workloadId: z.string().regex(/^wld_[A-Za-z0-9]+(?:-r\d{1,3})?$/),
	projectId: z.string(),
	userId: z.string(),
	scopes: z.array(z.enum(containerConsoleScopes)).min(1),
	expiresAt: z.string(),
});
export type ContainerConsoleActivation = z.infer<typeof containerConsoleActivationSchema>;

/** Desired state: run the console front on this port, or null to stay closed. */
export const nodeContainerConsoleDesiredSchema = z.object({
	port: z.number().int().min(1).max(65_535),
});
export type NodeContainerConsoleDesired = z.infer<typeof nodeContainerConsoleDesiredSchema>;

// --- inspect ---------------------------------------------------------------------------------

export const containerProcessSchema = z.object({
	/** PID inside the container's namespace (host PID when it cannot be read). */
	pid: z.number().int(),
	ppid: z.number().int(),
	uid: z.number().int(),
	state: z.string(),
	/** Resident memory in bytes. */
	rssBytes: z.number().nonnegative(),
	/** CPU time used since the process started, in microseconds. */
	cpuMicros: z.number().nonnegative(),
	startedAt: z.string().nullable(),
	command: z.string(),
});
export type ContainerProcess = z.infer<typeof containerProcessSchema>;

export const containerMountSchema = z.object({
	destination: z.string(),
	type: z.string(),
	readOnly: z.boolean(),
	/** True when the file browser can show it (bind mounts other than the secrets dir). */
	browsable: z.boolean(),
	/** Why it is not browsable (`tmpfs`, `secrets`, …). */
	note: z.string().nullable(),
});

export const containerStatsSchema = z.object({
	/** When the counters were read; the dashboard derives rates from two samples. */
	sampledAt: z.string(),
	cpuMicros: z.number().nonnegative().nullable(),
	memoryBytes: z.number().nonnegative().nullable(),
	memoryPeakBytes: z.number().nonnegative().nullable(),
	memoryLimitBytes: z.number().nonnegative().nullable(),
	/** Kernel OOM kills inside this container's cgroup since it started. */
	oomKills: z.number().int().nonnegative().nullable(),
	pids: z.number().int().nonnegative().nullable(),
	pidsLimit: z.number().int().nonnegative().nullable(),
	netRxBytes: z.number().nonnegative().nullable(),
	netTxBytes: z.number().nonnegative().nullable(),
	blockReadBytes: z.number().nonnegative().nullable(),
	blockWriteBytes: z.number().nonnegative().nullable(),
});
export type ContainerStats = z.infer<typeof containerStatsSchema>;

export const containerInspectSchema = z.object({
	id: z.string(),
	name: z.string(),
	/** False when the unit exists but no container is running (stopped, crashed, restarting). */
	exists: z.boolean(),
	state: z.object({
		status: z.string(),
		running: z.boolean(),
		paused: z.boolean(),
		restarting: z.boolean(),
		oomKilled: z.boolean(),
		exitCode: z.number().int().nullable(),
		error: z.string().nullable(),
		startedAt: z.string().nullable(),
		finishedAt: z.string().nullable(),
		health: z.string().nullable(),
	}),
	/** systemd's view of the unit: active state and how often it restarted it. */
	unit: z.object({ activeState: z.string(), subState: z.string(), restarts: z.number().int().nonnegative() }),
	image: z.object({ name: z.string().nullable(), id: z.string().nullable(), digest: z.string().nullable() }),
	config: z.object({
		entrypoint: z.array(z.string()),
		command: z.array(z.string()),
		workingDir: z.string().nullable(),
		user: z.string().nullable(),
		hostname: z.string().nullable(),
		/** Environment variable names only; values (secrets among them) never leave the node. */
		envNames: z.array(z.string()),
		labels: z.record(z.string(), z.string()),
	}),
	security: z.object({
		readOnlyRootfs: z.boolean(),
		capAdd: z.array(z.string()),
		capDrop: z.array(z.string()),
		noNewPrivileges: z.boolean(),
	}),
	network: z.object({
		ports: z.array(z.object({ container: z.string(), host: z.string() })),
		networks: z.array(z.object({ name: z.string(), ip: z.string().nullable(), aliases: z.array(z.string()) })),
	}),
	mounts: z.array(containerMountSchema),
	stats: containerStatsSchema.nullable(),
	processes: z.array(containerProcessSchema),
});
export type ContainerInspect = z.infer<typeof containerInspectSchema>;

// --- files -----------------------------------------------------------------------------------

export const containerFileKinds = ['file', 'directory', 'symlink', 'socket', 'fifo', 'block', 'char', 'other'] as const;
export type ContainerFileKind = (typeof containerFileKinds)[number];

export const containerFileEntrySchema = z.object({
	name: z.string(),
	kind: z.enum(containerFileKinds),
	sizeBytes: z.number().nonnegative(),
	/** Octal permission bits, e.g. `0755`. */
	mode: z.string(),
	uid: z.number().int(),
	gid: z.number().int(),
	modifiedAt: z.string(),
	/** Symlinks only: where it points, as written. */
	linkTarget: z.string().nullable(),
});
export type ContainerFileEntry = z.infer<typeof containerFileEntrySchema>;

export const containerDirListingSchema = z.object({
	/** The directory listed, symlinks resolved inside the container. */
	path: z.string(),
	entries: z.array(containerFileEntrySchema),
	truncated: z.boolean(),
	/** The mount this directory lives on (`/` is the image's root filesystem). */
	mount: z.string(),
	readOnly: z.boolean(),
});
export type ContainerDirListing = z.infer<typeof containerDirListingSchema>;

/** A text preview. Binary or oversized files come back with `content: null` and a reason. */
export const containerFilePreviewSchema = z.object({
	path: z.string(),
	sizeBytes: z.number().nonnegative(),
	modifiedAt: z.string(),
	content: z.string().nullable(),
	reason: z.enum(['binary', 'too-large']).nullable(),
});
export type ContainerFilePreview = z.infer<typeof containerFilePreviewSchema>;

/** A path inside the container: absolute, no NUL, bounded. Normalisation happens on the node. */
export const containerPathSchema = z
	.string()
	.min(1)
	.max(containerConsoleLimits.pathLength)
	.refine((value: string) => value.startsWith('/') && !value.includes('\0'), 'Paths must be absolute.');

// --- exec ------------------------------------------------------------------------------------

/** Which shell to start. `auto` tries bash, then sh. Only these: no arbitrary command. */
export const containerShells = ['auto', '/bin/bash', '/bin/sh', '/bin/ash'] as const;
export type ContainerShell = (typeof containerShells)[number];

export const containerExecOpenSchema = z.object({
	shell: z.enum(containerShells).default('auto'),
	/** Run as the image's user (default) or root inside the container. Capabilities stay dropped. */
	user: z.enum(['default', 'root']).default('default'),
	cols: z.number().int().min(10).max(500).default(120),
	rows: z.number().int().min(4).max(200).default(32),
});
export type ContainerExecOpen = z.infer<typeof containerExecOpenSchema>;

export const containerExecResizeSchema = z.object({
	cols: z.number().int().min(10).max(500),
	rows: z.number().int().min(4).max(200),
});

export const containerExecIdPattern = /^cx_[A-Za-z0-9]{24}$/;

export const containerExecSessionSchema = z.object({
	execId: z.string().regex(containerExecIdPattern),
	shell: z.string(),
	user: z.string(),
	startedAt: z.string(),
});
export type ContainerExecSession = z.infer<typeof containerExecSessionSchema>;

/** The replica a console call targets; `null` for a single-copy workload. */
export const containerTargetSchema = z.object({
	replica: z.number().int().min(0).nullable(),
	nodeId: z.string(),
	nodeName: z.string(),
	desiredId: z.string(),
});
export type ContainerTarget = z.infer<typeof containerTargetSchema>;

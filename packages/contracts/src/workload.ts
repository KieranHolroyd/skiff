import * as z from 'zod';
import { composeSpecSchema } from './compose.ts';
import { databaseExtensionAllowlist, databaseMonitorSchema, workloadDatabaseSchema } from './database.ts';
import { storageAdminSchema, workloadObjectStorageSchema, workloadStorageStsSchema } from './object-storage.ts';
import { workloadBrokerSchema } from './broker.ts';
import { githubRunnerSchema } from './github-runner.ts';
import { MAX_REGISTRY_AUTH_ENTRIES, imageDigestSchema, registryAuthEntrySchema, workloadRegistrySchema } from './registry.ts';
import { workloadIdentityActivationSchema, workloadIdentitySpecSchema } from './workload-identity.ts';
import {
	FUNCTION_PYTHON_MIN_MEMORY_MB,
	FUNCTION_STATEFUL_REPLICA_MESSAGE,
	functionBindingIsStateful,
	functionIsPython,
	functionRuntimeSpecSchema,
} from './function.ts';

/**
 * Tier 2 (process), tier 3 (container) and tier 4 (function) workloads (DESIGN §3.4, §3.4.1, D41,
 * D110).
 *
 * A workload is the runtime half of a deployment: the same immutable release can be served
 * statically or executed by a sandboxed systemd unit (process), a rootless Quadlet (container) or
 * a pinned workerd process (function). The spec below is what the control plane validates and
 * admits; the agent renders it into systemd/Quadlet through the privileged helper. Nothing here is
 * shell: the helper takes structured fields and never interpolates a command line.
 */

export const workloadRuntimes = ['process', 'container', 'function', 'compose'] as const;

/**
 * `http` workloads listen on `port`, get a Caddy route and an HTTP health probe. `none` is a
 * worker (plan 21, D89): no route, no published port, healthy while its unit is active. Runners,
 * queue consumers and bots are workers.
 */
export const workloadIngresses = ['http', 'none'] as const;
export type WorkloadIngress = (typeof workloadIngresses)[number];

/**
 * Replicas run on the workload's one node. More than one is allowed for workers and for stateless
 * functions (phase 4); a function with any stateful binding stays a single host (FN11).
 */
export const MAX_WORKLOAD_REPLICAS = 20;
export type WorkloadRuntime = (typeof workloadRuntimes)[number];

/**
 * The JavaScript runtime a process app runs on (D125). `bun` is Skiff's own and the default;
 * `node` is the pinned Node.js LTS the installer puts on every node. Absent means `bun`, so a spec
 * saved before engines existed hashes (and restarts) exactly as it did.
 */
export const processEngines = ['bun', 'node'] as const;
export type ProcessEngine = (typeof processEngines)[number];

/**
 * Bun's default argv for a process spec with no `command`. A Node.js app with no command runs its
 * package.json `start` script through `/bin/sh -c` on the node instead (D125): `npm start` and
 * `node --run start` spawn the script with every non-stdio fd closed, which loses the activated
 * socket, while a shell passes it on.
 */
export const BUN_DEFAULT_COMMAND: readonly string[] = ['bun', 'run', 'start'];

/** Script launchers that close fd 3 before the app starts (checked on Linux, Node 24 and 26). */
const NODE_FD_CLOSING_LAUNCHERS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'corepack']);

/**
 * Why a Node.js command cannot serve on the activated socket, or null (D125). Only matters with
 * socket activation on; without it the app listens on `PORT` and any launcher works.
 */
export function nodeCommandIssue(spec: {
	runtime: WorkloadRuntime;
	engine?: ProcessEngine;
	command?: string[];
	socketActivation: boolean;
}): string | null {
	if (spec.runtime !== 'process' || spec.engine !== 'node' || !spec.socketActivation || !spec.command) return null;
	const executable = spec.command[0]!.split('/').pop()!;
	const viaRun = executable === 'node' && spec.command.includes('--run');
	if (!viaRun && !NODE_FD_CLOSING_LAUNCHERS.has(executable)) return null;
	return `${viaRun ? 'node --run' : executable} starts the app without the activated socket. Leave the command blank to run the package.json start script, run the server directly (node server.js), or turn socket activation off.`;
}

/** Heartbeat capability of a node whose pinned Node.js is installed (D125); placement needs it. */
export const PROCESS_NODE_CAPABILITY = 'process-node';

/** Upper bound for a process app's idle stop (D121), the same day-long cap functions use. */
export const PROCESS_MAX_IDLE_STOP_SECONDS = 86_400;

/**
 * Why a spec cannot scale to zero, or null when it can (D121). Scale to zero needs a socket that
 * keeps listening while the unit is stopped, so it is only for socket-activated HTTP process apps
 * with one copy (process replicas share the project socket). Functions use their manifest field.
 */
export function processIdleStopIssue(spec: {
	runtime: WorkloadRuntime;
	socketActivation: boolean;
	ingress: WorkloadIngress;
	replicas: number;
}): { path: string; message: string } | null {
	if (spec.runtime !== 'process')
		return {
			path: 'idleStopSeconds',
			message:
				spec.runtime === 'function'
					? 'Functions set idle stop in their manifest (skiff.idleStopSeconds in wrangler.jsonc).'
					: 'Idle stop is for process apps; containers are always on.',
		};
	if (spec.ingress !== 'http')
		return { path: 'idleStopSeconds', message: 'Workers have no requests to wake them; idle stop needs HTTP ingress.' };
	if (!spec.socketActivation)
		return {
			path: 'socketActivation',
			message: 'Idle stop needs socket activation: the socket keeps listening and starts the app on the next request.',
		};
	if (spec.replicas > 1)
		return { path: 'replicas', message: 'Idle stop needs a single replica (replicas share one socket).' };
	return null;
}

/** `env` injects `NAME=value`; `file` writes a 0400 file and points `NAME_FILE` at it. */
export const secretDeliveryModes = ['env', 'file'] as const;
export type SecretDeliveryMode = (typeof secretDeliveryModes)[number];

export const secretRefSchema = z.object({
	name: z
		.string()
		.regex(/^[A-Z][A-Z0-9_]*$/, 'Secret names must be UPPER_SNAKE_CASE')
		.max(128),
	/** Pinned version; omitted means "the latest at activation". */
	version: z.number().int().positive().optional(),
	delivery: z.enum(secretDeliveryModes).default('env'),
});
export type SecretRef = z.infer<typeof secretRefSchema>;

/** Plain (readable) environment variables: `NAME=value`, names as POSIX shells accept them. */
export const workloadEnvSchema = z
	.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(16_384))
	.default({});
export const workloadSecretRefsSchema = z.array(secretRefSchema).max(128).default([]);

export const workloadSpecSchema = z
	.object({
		runtime: z.enum(workloadRuntimes),
		/**
		 * Process: argv executed inside the release directory (no shell). Defaults to
		 * `["bun", "run", "start"]` when the release ships a package.json, else the deployment fails
		 * with a validation error naming the field.
		 */
		command: z.array(z.string().min(1).max(1024)).min(1).max(64).optional(),
		/**
		 * Process only (D125): `bun` (absent) or `node`. Node apps with no command run their
		 * package.json `start` script, land only on nodes with the pinned Node.js, and adopt the
		 * activated socket without code changes, so they can scale to zero.
		 */
		engine: z.enum(processEngines).optional(),
		/** Container: OCI image reference. Mutually exclusive with `command`. */
		image: z.string().min(1).max(512).optional(),
		/**
		 * Container, set by Skiff only (R1, docs/REGISTRY.md): the digest `image` resolved to when
		 * the deployment was created. The node runs `<repository>@<digest>`, so a deployment and its
		 * rollback always start the same bytes. Inputs drop it (`setSpec`, REST, MCP).
		 */
		imageDigest: imageDigestSchema.optional(),
		/** Port the app listens on; the agent binds it and Caddy proxies locally. */
		port: z.number().int().min(1).max(65535).default(3000),
		/** Admission unit: the agent sets `MemoryMax` and the slice reserves the same amount. */
		memoryMb: z.number().int().min(32).max(8192).default(256),
		cpus: z.number().positive().max(8).default(1),
		/** Health/proxy check path; the agent waits for this before reporting the workload ready. */
		healthPath: z.string().startsWith('/').max(512).default('/'),
		/** Process only: pass the listen socket with `LISTEN_FDS` (systemd socket activation). */
		socketActivation: z.boolean().default(true),
		/**
		 * Process only (D121): stop the unit after this many seconds without a request; the socket
		 * keeps listening and the next request cold-starts it. Needs socket activation, so the app
		 * must adopt the inherited listener (fd 3). Absent or `0` means always on. Functions set
		 * the same thing on their manifest (`function.idleStopSeconds`, FN4).
		 */
		idleStopSeconds: z.number().int().min(0).max(PROCESS_MAX_IDLE_STOP_SECONDS).optional(),
		/** Plain (readable) environment variables captured in the config snapshot. */
		env: workloadEnvSchema,
		/** Write-only secret references, resolved at activation. Values never live in the spec. */
		secrets: workloadSecretRefsSchema,
		/** Persistent data directory (a SQLite file per project by default, DESIGN §3.4). */
		data: z
			.object({ sizeMb: z.number().int().min(32).max(65_536).default(256) })
			.optional(),
		/** `none` makes a worker: no port, no route, health is "the unit is active" (D89). */
		ingress: z.enum(workloadIngresses).default('http'),
		/** Identical copies on the same node; `memoryMb`/`cpus` are per replica (D90). */
		replicas: z.number().int().min(1).max(MAX_WORKLOAD_REPLICAS).default(1),
		/** GitHub Actions runner profile (plan 21); container workers only. */
		runner: githubRunnerSchema.optional(),
		/**
		 * Workload identity (IAM.md I18, §7.4): the service account this workload runs as. Absent
		 * means the control plane creates and uses `wl-<project>-<env>`; an override must name an
		 * existing service account in the same org.
		 */
		identity: workloadIdentitySpecSchema.optional(),
		/**
		 * Functions only (D110): the resolved manifest. The control plane validates a bundle into
		 * this; the agent renders a workerd config from it and the helper starts the pinned binary.
		 */
		function: functionRuntimeSpecSchema.optional(),
		/**
		 * Compose only: every service, named volume and exposed route in the stack. The release is
		 * only a marker; the services are the program.
		 */
		compose: composeSpecSchema.optional(),
	})
	.superRefine((spec, ctx) => {
		if (spec.runtime === 'compose' && !spec.compose)
			ctx.addIssue({ code: 'custom', path: ['compose'], message: 'Compose workloads need a parsed compose spec.' });
		if (spec.compose && spec.runtime !== 'compose')
			ctx.addIssue({ code: 'custom', path: ['runtime'], message: 'A compose spec needs runtime "compose".' });
		if (spec.runtime === 'compose') {
			for (const field of ['command', 'engine', 'image', 'imageDigest', 'runner', 'function', 'data'] as const)
				if (spec[field] !== undefined)
					ctx.addIssue({
						code: 'custom',
						path: [field],
						message: 'Compose services carry their own image and command; the workload cannot set this.',
					});
			if (spec.replicas > 1)
				ctx.addIssue({
					code: 'custom',
					path: ['replicas'],
					message: 'A compose stack is one host; scale individual services in the compose file.',
				});
			// Services receive secret values as environment variables; there is no per-service file
			// mount to point a file-delivery reference at.
			if (spec.secrets.some((secret) => secret.delivery === 'file'))
				ctx.addIssue({
					code: 'custom',
					path: ['secrets'],
					message: 'Compose services take env secrets; file delivery is not supported.',
				});
		}
		if (spec.runtime === 'function' && !spec.function)
			ctx.addIssue({ code: 'custom', path: ['function'], message: 'Function workloads need a resolved function spec.' });
		if (spec.function && spec.runtime !== 'function')
			ctx.addIssue({ code: 'custom', path: ['runtime'], message: 'A function spec needs runtime "function".' });
		if (spec.runtime === 'function') {
			if (spec.image)
				ctx.addIssue({ code: 'custom', path: ['image'], message: 'Function workloads cannot set an image.' });
			if (spec.command)
				ctx.addIssue({ code: 'custom', path: ['command'], message: 'Function workloads cannot set a command.' });
			if (spec.runner)
				ctx.addIssue({ code: 'custom', path: ['runner'], message: 'Runners cannot be functions.' });
			if (spec.data)
				ctx.addIssue({
					code: 'custom',
					path: ['data'],
					message: 'Functions keep state in Durable Objects, not a data directory (phase 2).',
				});
			if (spec.ingress !== 'http')
				ctx.addIssue({ code: 'custom', path: ['ingress'], message: 'Functions need HTTP ingress.' });
			if (spec.function && functionIsPython(spec.function) && spec.memoryMb < FUNCTION_PYTHON_MIN_MEMORY_MB)
				ctx.addIssue({
					code: 'custom',
					path: ['memoryMb'],
					message: `A Python function needs at least ${FUNCTION_PYTHON_MIN_MEMORY_MB} MB (Pyodide is about 230 MB resident).`,
				});
			if (spec.replicas > 1 && spec.function?.bindings.some((binding) => functionBindingIsStateful(binding.type)))
				ctx.addIssue({
					code: 'custom',
					path: ['replicas'],
					message: FUNCTION_STATEFUL_REPLICA_MESSAGE,
				});
		}
		// Several copies are valid for stateless HTTP workloads (C4); a data directory still pins
		// the workload to one node and one writer.
		if (spec.replicas > 1 && spec.ingress !== 'none' && spec.data)
			ctx.addIssue({
				code: 'custom',
				path: ['replicas'],
				message: 'A workload with a persistent data directory cannot run more than one replica.',
			});
		if (spec.runner && spec.runtime !== 'container')
			ctx.addIssue({ code: 'custom', path: ['runner'], message: 'Runners use the container runtime.' });
		if (spec.identity && spec.runtime === 'function')
			ctx.addIssue({
				code: 'custom',
				path: ['identity'],
				message: 'Workload identity is for process and container workloads.',
			});
		if (spec.identity && spec.runner)
			ctx.addIssue({
				code: 'custom',
				path: ['identity'],
				message: 'Ephemeral CI runners do not get a workload identity.',
			});
		if (spec.runner && spec.ingress !== 'none')
			ctx.addIssue({ code: 'custom', path: ['ingress'], message: 'Runners are workers; set ingress to "none".' });
		if (spec.runner && spec.data)
			ctx.addIssue({ code: 'custom', path: ['data'], message: 'Runners are ephemeral and cannot keep a data directory.' });
		if (spec.runtime === 'process' && spec.image)
			ctx.addIssue({ code: 'custom', path: ['image'], message: 'Process workloads cannot set an image.' });
		if (spec.engine && spec.runtime !== 'process')
			ctx.addIssue({ code: 'custom', path: ['engine'], message: 'Only process apps choose a JavaScript engine.' });
		const nodeIssue = nodeCommandIssue(spec);
		if (nodeIssue) ctx.addIssue({ code: 'custom', path: ['command'], message: nodeIssue });
		if ((spec.idleStopSeconds ?? 0) > 0) {
			const issue = processIdleStopIssue(spec);
			if (issue) ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
		}
		if (spec.runtime === 'container' && spec.command)
			ctx.addIssue({ code: 'custom', path: ['command'], message: 'Container workloads cannot set a command.' });
		if (spec.runtime === 'container' && !spec.image)
			ctx.addIssue({ code: 'custom', path: ['image'], message: 'Container workloads need an image.' });
		if (spec.imageDigest && spec.runtime !== 'container')
			ctx.addIssue({ code: 'custom', path: ['imageDigest'], message: 'Only container workloads pin an image digest.' });
	});
export type WorkloadSpec = z.infer<typeof workloadSpecSchema>;
/** What callers may pass before defaults apply (`ingress`, `replicas`, … optional). */
export type WorkloadSpecInput = z.input<typeof workloadSpecSchema>;

/**
 * One save from the Variables view: the full plain env and secret references, plus values for
 * project secrets to create (or add a version to) before the spec is written.
 */
export const workloadVariablesSchema = z.object({
	env: workloadEnvSchema,
	secrets: workloadSecretRefsSchema,
	newSecrets: z
		.array(
			z.object({
				name: secretRefSchema.shape.name,
				value: z.string().min(1, 'Secret values cannot be empty.').max(65_536),
			}),
		)
		.max(64)
		.default([]),
});
export type WorkloadVariables = z.input<typeof workloadVariablesSchema>;

/**
 * The environment variable a secret reference sets: `NAME` for env delivery, `NAME_FILE` (the
 * path of the 0400 file) for file delivery.
 */
export function secretRefEnvName(ref: Pick<SecretRef, 'name' | 'delivery'>): string {
	return ref.delivery === 'file' ? `${ref.name}_FILE` : ref.name;
}

/**
 * Names a spec would set twice. A secret reference is applied after plain env, so a clash
 * silently hides the plain value; a duplicate reference hides the first one. Checked on write
 * only, so specs saved before this check still load.
 */
export function workloadEnvIssues(spec: Pick<WorkloadSpec, 'env' | 'secrets'>): string[] {
	const issues: string[] = [];
	const refs = new Map<string, SecretRef>();
	for (const ref of spec.secrets) {
		const name = secretRefEnvName(ref);
		if (refs.has(name)) {
			issues.push(`Secret ${ref.name} is referenced more than once.`);
			continue;
		}
		refs.set(name, ref);
		if (Object.hasOwn(spec.env, name))
			issues.push(`${name} is set both as a plain variable and by secret ${ref.name}. Keep one.`);
	}
	return issues;
}

export const workloadStatuses = ['pending', 'starting', 'running', 'failed', 'stopped'] as const;
export type WorkloadStatus = (typeof workloadStatuses)[number];

/** The pre-isolation network every container joined; kept as the fallback for old desired state. */
export const DEFAULT_WORKLOAD_NETWORK = 'skiff-workloads';
export const ORG_NETWORK_PREFIX = 'skiff-org-';

/**
 * Derive an org's private Podman network name. The name is not stored: it is a pure function of
 * the org id, so old desired-state documents and new ones agree without a migration.
 */
export function orgNetworkName(orgId: string): string {
	const label = orgId
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return `${ORG_NETWORK_PREFIX}${label}`;
}

/**
 * The network a workload belongs to. A control plane that enables `ORG_NETWORKS` sends both
 * `orgId` and `networkName`; an older one sends neither and the helper keeps the shared network.
 */
export function workloadNetworkName(workload: {
	orgId?: string;
	networkName?: string;
}): string {
	if (workload.networkName) return workload.networkName;
	if (workload.orgId) return orgNetworkName(workload.orgId);
	return DEFAULT_WORKLOAD_NETWORK;
}

/** True when two workloads can resolve each other's container aliases. */
export function workloadsShareNetwork(
	a: { orgId?: string; networkName?: string },
	b: { orgId?: string; networkName?: string },
): boolean {
	return workloadNetworkName(a) === workloadNetworkName(b);
}

export interface WorkloadView {
	id: string;
	projectId: string;
	projectSlug: string;
	deploymentId: string;
	nodeId: string | null;
	runtime: WorkloadRuntime;
	status: WorkloadStatus;
	/** `none` for workers (plan 21). */
	ingress: WorkloadIngress;
	replicas: number;
	/** Set for CI runner pools; details come from `GET /projects/:slug/runners`. */
	runner: { provider: 'github'; target: string } | null;
	/** Total reservation across replicas. */
	memoryMb: number;
	cpus: number;
	/** Process/container upstream Caddy on the target node proxies to. */
	upstream: string | null;
	/** Containers: the configured image reference. */
	image: string | null;
	/** Containers: the digest the running deployment is pinned to (R1); null when it runs a tag. */
	imageDigest: string | null;
	message: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface NodeCapacityView {
	nodeId: string;
	name: string;
	mode: string;
	status: string;
	sliceMemoryMb: number;
	reservedMemoryMb: number;
	freeMemoryMb: number;
	workloadCount: number;
	/** Latest root/data-disk free space the node reported; null before the first heartbeat. */
	diskFreeBytes: number | null;
	diskTotalBytes: number | null;
	/** App volumes backed by the helper state directory on this node, as a disk reservation. */
	reservedDiskBytes: number;
}

/** Placement request: `edge`, a node id, or `auto` (resolved once at deploy time, D41). */
export const placementSchema = z.string().min(1).max(64).default('edge');

/**
 * One app volume attached to a workload (plan 07). The helper resolves the backing directory
 * from its own registry: desired state names the volume and mount point, never a host path.
 * Optional so an older agent that predates app volumes ignores it (unknown fields are dropped).
 */
export const workloadVolumeMountSchema = z.object({
	id: z.string().min(1).max(100),
	mountPath: z.string().min(1).max(200),
	readOnly: z.boolean().default(false),
	/**
	 * How the helper resolves the backing directory. `node_volume` (the wire name for a disk) names
	 * a disk in the helper's own registry, verified before start; `state_dir` is the helper's state
	 * directory on the system disk.
	 * These are ids and kinds only — never a host path or a device.
	 */
	backing: z.enum(['node_volume', 'state_dir']).optional(),
	nodeVolumeId: z.string().min(1).max(100).optional(),
});
export type WorkloadVolumeMount = z.infer<typeof workloadVolumeMountSchema>;

/** One process in a multi-process workload (plan 19). */
export const workloadProcessSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(40)
		.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Process names use lowercase letters, digits and hyphens.'),
	command: z.array(z.string().min(1).max(1024)).min(1).max(64),
	port: z.number().int().min(1).max(65535).optional(),
	healthPath: z.string().startsWith('/').max(512).optional(),
});
export type WorkloadProcess = z.infer<typeof workloadProcessSchema>;

/** A scheduled job that runs the workload's release (plan 09). */
export const workloadJobSchema = z.object({
	id: z.string().min(1).max(100),
	timeoutSeconds: z.number().int().min(10).max(86_400),
});
export type WorkloadJob = z.infer<typeof workloadJobSchema>;

/**
 * What one node must converge for its local workloads. Secret *values* are deliberately absent:
 * the agent fetches them just-in-time from `/api/agent/workloads/:id/activation`, so the cached
 * desired-state file on disk never contains a secret (D18, D23).
 *
 * The `volumes`, `processes` and `job` fields are additive and optional (F1). An older agent
 * ignores fields it does not know, so the same desired state works across agent versions.
 */
export const workloadDesiredSchema = z.object({
	id: z.string(),
	projectId: z.string(),
	projectSlug: z.string(),
	deploymentId: z.string(),
	/**
	 * Owning org for network isolation (plan 04b). Optional so an older control plane can omit it;
	 * the helper then keeps the legacy shared network. The helper derives the network name from it.
	 */
	orgId: z.string().max(100).optional(),
	/** Explicit network name; normally derived from `orgId`. Validated by the helper. */
	networkName: z.string().max(100).optional(),
	runtime: z.enum(workloadRuntimes),
	status: z.enum(workloadStatuses),
	/** Content-addressed release the unit runs from; null for a pure image container. */
	release: z.string().length(64).nullable(),
	/** Process workloads: fixed argv. Absent means the helper's default for `engine`. */
	command: z.array(z.string().min(1).max(1024)).min(1).max(64).optional(),
	/** Process workloads on Node.js (D125). Omitted for Bun, so their desired state is unchanged. */
	engine: z.literal('node').optional(),
	/** Container workloads: the OCI image to run. */
	image: z.string().min(1).max(512).optional(),
	upstream: z.string(),
	memoryMb: z.number().int().positive(),
	cpus: z.number().positive(),
	port: z.number().int().positive(),
	healthPath: z.string(),
	socketActivation: z.boolean(),
	/**
	 * Process apps that scale to zero (D121): the agent stops the unit after this many idle
	 * seconds and leaves the socket listening. Omitted when off, so other desired state is unchanged.
	 */
	idleStopSeconds: z.number().int().positive().optional(),
	/** Hash of the public spec + secret refs; a change tells the agent to re-fetch activation. */
	activationVersion: z.string().length(64),
	/** Public env vars only; secret values arrive through the activation endpoint. */
	env: z.record(z.string(), z.string()).default({}),
	/** Secret references to fetch at activation. */
	secrets: z.array(secretRefSchema).default([]),
	/** Set when the workload needs a writable data directory at `/data`. */
	dataSizeMb: z.number().int().positive().nullable().default(null),
	/** Managed database profile (D55, D61); the helper derives image, user and mounts from it. */
	database: workloadDatabaseSchema.optional(),
	/** Managed database pooler (PgBouncer sidecar) host port; omitted when disabled. */
	pooler: z.object({ port: z.number().int().positive() }).optional(),
	/** Managed object storage profile (S1); buckets and scoped users are converged by the agent. */
	objectStorage: workloadObjectStorageSchema.optional(),
	/** Managed queue broker profile (D111); the helper derives image, user, config and mounts. */
	broker: workloadBrokerSchema.optional(),
	/** The platform registry (docs/REGISTRY.md G1): zot, rendered by the helper from this profile. */
	registry: workloadRegistrySchema.optional(),
	/**
	 * Managed services only: the disk the data dir lives on (D169; absent = the system disk). The
	 * helper resolves the mount path from its own registry and fails the start if it is not mounted
	 * (D76).
	 */
	volumeId: z.string().max(100).optional(),
	/** App volumes mounted into this workload (plan 07); omitted by older control planes. */
	volumes: z.array(workloadVolumeMountSchema).max(20).optional(),
	/** Additional processes in one release (plan 19); omitted by older control planes. */
	processes: z.array(workloadProcessSchema).max(20).optional(),
	/** The project's scheduled job, when this workload is also its runner (plan 09). */
	job: workloadJobSchema.optional(),
	/** Present only for workers (plan 21): no published port, no route, unit-active health. */
	ingress: z.literal('none').optional(),
	/**
	 * Ephemeral CI runner profile (plan 21). The helper derives the entrypoint, `Restart=no` and
	 * `Pull=newer` from it; the agent re-applies a replica that exited so it gets a fresh JIT config.
	 */
	runner: z.object({ provider: z.literal('github') }).optional(),
	/**
	 * Workload identity is enabled for this app (IAM.md I18). The helper mounts
	 * `/run/skiff/identity/<id>/token` at `/var/run/skiff/token` and exports `SKIFF_TOKEN_FILE`.
	 * Only a marker travels here; the token itself arrives through activation.
	 */
	identity: z.literal(true).optional(),
	/**
	 * Functions only (D110): the resolved manifest and the pinned workerd build. The agent renders
	 * a workerd config from it; the helper writes that config and starts the binary.
	 */
	function: functionRuntimeSpecSchema.optional(),
	/**
	 * Compose only: the services this stack runs and the routes that reach them. `hostPort` is the
	 * loopback port the helper publishes; each service is a rootless container on the shared
	 * workload network, addressed by service name.
	 */
	compose: composeSpecSchema.optional(),
	/**
	 * Which copy this is when the spec asks for replicas; replica 0 keeps the workload id and the
	 * others are `<id>-r<index>`. The count is deliberately absent so scaling never restarts a copy.
	 */
	replica: z.object({ index: z.number().int().min(0).max(MAX_WORKLOAD_REPLICAS - 1) }).optional(),
});
export type WorkloadDesired = z.infer<typeof workloadDesiredSchema>;

/** Desired-state id of one replica: the workload id for replica 0, `<id>-r<n>` otherwise. */
export function workloadReplicaId(workloadId: string, index: number): string {
	return index === 0 ? workloadId : `${workloadId}-r${index}`;
}

/** Inverse of `workloadReplicaId`. */
export function parseWorkloadReplicaId(id: string): { workloadId: string; replica: number } {
	const match = /^(.+)-r([1-9][0-9]?)$/.exec(id);
	if (!match) return { workloadId: id, replica: 0 };
	return { workloadId: match[1]!, replica: Number(match[2]) };
}

/** Activation payload: decrypted values, returned only to the authenticated node. */
export const workloadActivationSchema = z.object({
	workloadId: z.string(),
	activationVersion: z.string().length(64),
	env: z.record(z.string(), z.string()),
	/** Secret files keyed by the name the unit expects (`LoadCredential`/`EnvironmentFile`). */
	files: z.record(z.string(), z.string()).default({}),
	/** Managed databases only: stats-sampler credentials, kept in agent memory (D57). */
	monitor: databaseMonitorSchema.optional(),
	/** Managed databases only: extensions to install idempotently on first start. */
	databaseSetup: z
		.object({ extensions: z.array(z.string().max(64)).max(databaseExtensionAllowlist.length).default([]) })
		.optional(),
	/** Storage instances only: root and scoped keys for bucket/user reconcile, agent memory only. */
	storageAdmin: storageAdminSchema.optional(),
	/**
	 * Containers only (R2): registry credentials for the image's registry. The helper writes them
	 * to the workload's 0400 auth file and points `AuthFile=` at it; absent when none apply.
	 */
	registryAuth: z.array(registryAuthEntrySchema).max(MAX_REGISTRY_AUTH_ENTRIES).optional(),
	/**
	 * Process and container apps only: a short-lived workload JWT for Skiff's API. The agent hands
	 * it to the helper, which writes the 0400 file; it never reaches desired state, logs or audit.
	 */
	identity: workloadIdentityActivationSchema.optional(),
	/**
	 * Attached storage that received temporary RustFS STS credentials instead of its sealed static
	 * key (IAM.md §7.4, I18). The credentials themselves are in `env`
	 * (`<prefix>_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_SESSION_TOKEN`); this marks which
	 * prefixes are temporary and when they expire. Absent when every attachment fell back to its
	 * static key.
	 */
	storageSts: z.array(workloadStorageStsSchema).max(20).optional(),
});
export type WorkloadActivation = z.infer<typeof workloadActivationSchema>;

export const workloadUpdateSchema = workloadSpecSchema;
export type WorkloadUpdate = z.infer<typeof workloadUpdateSchema>;

/** `POST /projects/:slug/deploy-image` (docs/REGISTRY.md §5.3): set a container's image and deploy it. */
export const imageDeploySchema = z.object({
	image: z.string().trim().min(1).max(512),
	promote: z.boolean().optional(),
	message: z.string().max(500).optional(),
	environment: z.string().min(1).max(40).optional(),
});
export type ImageDeployInput = z.input<typeof imageDeploySchema>;

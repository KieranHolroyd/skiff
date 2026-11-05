import * as z from 'zod';
import { databaseMonitorSchema, workloadDatabaseSchema } from './database.ts';
import { storageAdminSchema, workloadObjectStorageSchema } from './object-storage.ts';

/**
 * Tier 2 (process) and tier 3 (container) workloads (DESIGN §3.4, §3.4.1, D41).
 *
 * A workload is the runtime half of a deployment: the same immutable release can be served
 * statically or executed by a sandboxed systemd unit (process) or a rootless Quadlet (container).
 * The spec below is what the control plane validates and admits; the agent renders it into
 * systemd/Quadlet through the privileged helper. Nothing here is shell: the helper takes structured
 * fields and never interpolates a command line.
 */

export const workloadRuntimes = ['process', 'container'] as const;
export type WorkloadRuntime = (typeof workloadRuntimes)[number];

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

export const workloadSpecSchema = z
	.object({
		runtime: z.enum(workloadRuntimes),
		/**
		 * Process: argv executed inside the release directory (no shell). Defaults to
		 * `["bun", "run", "start"]` when the release ships a package.json, else the deployment fails
		 * with a validation error naming the field.
		 */
		command: z.array(z.string().min(1).max(1024)).min(1).max(64).optional(),
		/** Container: OCI image reference. Mutually exclusive with `command`. */
		image: z.string().min(1).max(512).optional(),
		/** Port the app listens on; the agent binds it and Caddy proxies locally. */
		port: z.number().int().min(1).max(65535).default(3000),
		/** Admission unit: the agent sets `MemoryMax` and the slice reserves the same amount. */
		memoryMb: z.number().int().min(32).max(8192).default(256),
		cpus: z.number().positive().max(8).default(1),
		/** Health/proxy check path; the agent waits for this before reporting the workload ready. */
		healthPath: z.string().startsWith('/').max(512).default('/'),
		/** Process only: pass the listen socket with `LISTEN_FDS` (systemd socket activation). */
		socketActivation: z.boolean().default(true),
		/** Plain (readable) environment variables captured in the config snapshot. */
		env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(16_384)).default({}),
		/** Write-only secret references, resolved at activation. Values never live in the spec. */
		secrets: z.array(secretRefSchema).max(128).default([]),
		/** Persistent data directory (a SQLite file per project by default, DESIGN §3.4). */
		data: z
			.object({ sizeMb: z.number().int().min(32).max(65_536).default(256) })
			.optional(),
	})
	.superRefine((spec, ctx) => {
		if (spec.runtime === 'process' && spec.image)
			ctx.addIssue({ code: 'custom', path: ['image'], message: 'Process workloads cannot set an image.' });
		if (spec.runtime === 'container' && spec.command)
			ctx.addIssue({ code: 'custom', path: ['command'], message: 'Container workloads cannot set a command.' });
		if (spec.runtime === 'container' && !spec.image)
			ctx.addIssue({ code: 'custom', path: ['image'], message: 'Container workloads need an image.' });
	});
export type WorkloadSpec = z.infer<typeof workloadSpecSchema>;

export const workloadStatuses = ['pending', 'starting', 'running', 'failed', 'stopped'] as const;
export type WorkloadStatus = (typeof workloadStatuses)[number];

export interface WorkloadView {
	id: string;
	projectId: string;
	projectSlug: string;
	deploymentId: string;
	nodeId: string | null;
	runtime: WorkloadRuntime;
	status: WorkloadStatus;
	memoryMb: number;
	cpus: number;
	/** Process/container upstream Caddy on the target node proxies to. */
	upstream: string | null;
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
}

/** Placement request: `edge`, a node id, or `auto` (resolved once at deploy time, D41). */
export const placementSchema = z.string().min(1).max(64).default('edge');

/**
 * What one node must converge for its local workloads. Secret *values* are deliberately absent:
 * the agent fetches them just-in-time from `/api/agent/workloads/:id/activation`, so the cached
 * desired-state file on disk never contains a secret (D18, D23).
 */
export const workloadDesiredSchema = z.object({
	id: z.string(),
	projectId: z.string(),
	projectSlug: z.string(),
	deploymentId: z.string(),
	runtime: z.enum(workloadRuntimes),
	status: z.enum(workloadStatuses),
	/** Content-addressed release the unit runs from; null for a pure image container. */
	release: z.string().length(64).nullable(),
	/** Process workloads: fixed argv. Absent means the agent's default (`bun run start`). */
	command: z.array(z.string().min(1).max(1024)).min(1).max(64).optional(),
	/** Container workloads: the OCI image to run. */
	image: z.string().min(1).max(512).optional(),
	upstream: z.string(),
	memoryMb: z.number().int().positive(),
	cpus: z.number().positive(),
	port: z.number().int().positive(),
	healthPath: z.string(),
	socketActivation: z.boolean(),
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
	/**
	 * Managed services only: the node volume the data dir lives on (D74). The helper resolves the
	 * mount path from its own registry and fails the start if it is not mounted (D76).
	 */
	volumeId: z.string().max(100).optional(),
});
export type WorkloadDesired = z.infer<typeof workloadDesiredSchema>;

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
	databaseSetup: z.object({ extensions: z.array(z.string().max(64)).max(20).default([]) }).optional(),
	/** Storage instances only: root and scoped keys for bucket/user reconcile, agent memory only. */
	storageAdmin: storageAdminSchema.optional(),
});
export type WorkloadActivation = z.infer<typeof workloadActivationSchema>;

export const workloadUpdateSchema = workloadSpecSchema;
export type WorkloadUpdate = z.infer<typeof workloadUpdateSchema>;

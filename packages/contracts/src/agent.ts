import * as z from 'zod';
import { accessModes, deploymentStatuses, nodeStatuses, runtimes } from './model.ts';
import { domainKinds } from './domain.ts';
import { workloadDesiredSchema, workloadStatuses } from './workload.ts';
import { databaseMetricBucketSchema, databaseSnapshotSchema } from './database.ts';
import {
	storageBucketDeletionSchema,
	storageBucketSnapshotSchema,
	storageMetricBucketSchema,
	storageRouteSchema,
} from './object-storage.ts';
import { nodeStorageSchema, nodeStorageStatusSchema } from './storage.ts';

/**
 * The agent protocol (DESIGN §3.3). The control plane stores desired state per node;
 * agents pull it, converge idempotently and report actual state.
 */

export const releaseSpecSchema = z.object({
	sha256: z.string().length(64),
	/** Presigned download URL. Null when the agent already has the release on disk. */
	url: z.string().nullable(),
	sizeBytes: z.number().int().nonnegative(),
	fileCount: z.number().int().nonnegative(),
	precompressed: z.boolean(),
});
export type ReleaseSpec = z.infer<typeof releaseSpecSchema>;

export const routeAccessSchema = z.object({
	mode: z.enum(accessModes),
	/** HMAC key the agent uses to verify/sign host-only cookies (never the platform key). */
	siteKey: z.string().min(16),
	/** Hashed password for `password` mode, verified by the control plane. */
	loginUrl: z.string().url(),
});
export type RouteAccess = z.infer<typeof routeAccessSchema>;

export const routeSpecSchema = z.object({
	projectId: z.string(),
	slug: z.string(),
	host: z.string(),
	deploymentId: z.string(),
	release: z.string().length(64),
	access: routeAccessSchema,
	accessMode: z.enum(accessModes),
	spa: z.boolean(),
	cleanUrls: z.boolean(),
	trailingSlash: z.enum(['always', 'never', 'ignore']),
	notFound: z.string().nullable(),
	redirects: z.array(z.object({
		from: z.string(),
		to: z.string(),
		status: z.number().int(),
	})).default([]),
	headers: z.array(z.object({
		path: z.string(),
		headers: z.record(z.string(), z.string()),
	})).default([]),
	/** When set, the edge proxies to a worker node instead of serving from local disk. */
	upstream: z.string().nullable().default(null),
	/**
	 * True for the `<slug>.<contentDomain>` route that follows the production pointer. Production
	 * is served through a per-project symlink (promote = symlink swap); previews are rooted
	 * directly at their immutable release. Older control planes omit it; agents then derive it
	 * from the host.
	 */
	production: z.boolean().optional(),
});
export type RouteSpec = z.infer<typeof routeSpecSchema>;

export const desiredStateSchema = z.object({
	version: z.number().int(),
	nodeId: z.string(),
	agentVersion: z.string(),
	generatedAt: z.string(),
	/** Content domain for hostname construction. */
	contentDomain: z.string(),
	/** Platform origin, for Caddy's on-demand TLS `ask` endpoint (custom domains). */
	platformOrigin: z.string().url().optional(),
	/** This node's `skiff-workloads.slice` budget; the agent applies it before starting units. */
	sliceMemoryMb: z.number().int().positive().optional(),
	/** CPUWeight for the same slice; omitted by older control planes (agent default 200). */
	sliceCpuWeight: z.number().int().positive().optional(),
	/** Where this node should keep its data; omitted by older control planes (D48). */
	storage: nodeStorageSchema.optional(),
	/** Releases this node must have locally, keyed by sha256. */
	releases: z.array(releaseSpecSchema),
	/** Every route on this node, production and preview. */
	routes: z.array(routeSpecSchema),
	/** Share links and sessions revoked since the last reconcile. */
	revocations: z.array(z.object({
		id: z.string(),
		kind: z.enum(['shareLink', 'session', 'email']),
		revokedAt: z.string(),
	})).default([]),
	/** Old slugs that 301 to a renamed project (DESIGN §5.1). */
	hostRedirects: z.array(z.object({
		host: z.string(),
		to: z.string(),
	})).default([]),
	/** Tier 2/3 workloads placed on this node (DESIGN §3.4.1), managed databases included. */
	workloads: z.array(workloadDesiredSchema).default([]),
	/** Purged databases whose data dir this node must delete, then report (D59). */
	databasePurges: z.array(z.string()).default([]),
	/** Public storage endpoints this node serves (S3): byte-for-byte proxies, not sites. */
	storageRoutes: z.array(storageRouteSchema).default([]),
	/** Purged storage instances whose data dir this node must delete, then report (S8). */
	storagePurges: z.array(z.string()).default([]),
	/** Custom domains this node serves; TLS is on-demand and authorized by the control plane. */
	domains: z.array(z.object({
		host: z.string(),
		projectId: z.string(),
		kind: z.enum(domainKinds),
		/** When set, this host 301s to the sibling (apex↔www). */
		redirectTo: z.string().nullable().default(null),
	})).default([]),
});
export type DesiredState = z.infer<typeof desiredStateSchema>;

export const heartbeatSchema = z.object({
	nodeId: z.string(),
	agentVersion: z.string(),
	actualStateVersion: z.number().int().nonnegative(),
	status: z.enum(nodeStatuses),
	caddyOk: z.boolean(),
	stats: z.object({
		cpuPercent: z.number().nonnegative(),
		memoryBytes: z.number().int().nonnegative(),
		memoryTotalBytes: z.number().int().nonnegative(),
		diskUsedBytes: z.number().int().nonnegative(),
		diskTotalBytes: z.number().int().nonnegative(),
		uptimeSeconds: z.number().nonnegative(),
		load1: z.number().nonnegative(),
		/**
		 * TLS certificates this node's Caddy serves, probed locally (DESIGN §8 "cert expiring < 14 d").
		 * `host` is the SNI probed (`*.<contentDomain>` for the wildcard); `notAfter` is ISO 8601.
		 */
		certs: z.array(z.object({ host: z.string().max(253), notAfter: z.string().max(40) })).max(50),
	}).partial().optional(),
	releases: z.array(z.object({ sha256: z.string(), sizeBytes: z.number().int().nonnegative() })).default([]),
	/** What the node's storage service last applied (D48). */
	storage: nodeStorageStatusSchema.optional(),
	/** Actual workload state, so the fleet view reflects restart loops and OOM kills (DESIGN §9). */
	workloads: z.array(z.object({
		id: z.string(),
		status: z.enum(workloadStatuses),
		restarts: z.number().int().nonnegative().default(0),
		memoryBytes: z.number().int().nonnegative().optional(),
	})).optional(),
	/** Database ids whose data dir was deleted after a `databasePurges` entry (D59). */
	purgedDatabases: z.array(z.string()).optional(),
	/** Storage instance ids whose data dir was deleted after a `storagePurges` entry (S8). */
	purgedStorage: z.array(z.string()).optional(),
	/** Outcomes of `objectStorage.deleteBuckets` entries since the last heartbeat. */
	storageBucketDeletions: z.array(storageBucketDeletionSchema).max(500).optional(),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

/** Pre-aggregated 1-minute access buckets; raw requests never reach DuckDB (DESIGN §8). */
export const metricBucketSchema = z.object({
	host: z.string(),
	projectId: z.string().nullable().optional(),
	bucket: z.string(),
	requests: z.number().int().nonnegative(),
	status2xx: z.number().int().nonnegative(),
	status3xx: z.number().int().nonnegative(),
	status4xx: z.number().int().nonnegative(),
	status5xx: z.number().int().nonnegative(),
	bytes: z.number().int().nonnegative(),
	durationP50Ms: z.number().nonnegative(),
	durationP95Ms: z.number().nonnegative(),
	topPaths: z.array(z.object({ path: z.string(), count: z.number().int() })).default([]),
	topReferrers: z.array(z.object({ referrer: z.string(), count: z.number().int() })).default([]),
});
export type MetricBucket = z.infer<typeof metricBucketSchema>;

export const telemetryBatchSchema = z.object({
	nodeId: z.string(),
	buckets: z.array(metricBucketSchema).max(5000).default([]),
	/** Managed database samples (D57). */
	databases: z.array(databaseMetricBucketSchema).max(5000).default([]),
	/** Latest table snapshot per database (only the newest is kept). */
	databaseSnapshots: z.array(databaseSnapshotSchema).max(200).default([]),
	/** Managed object storage samples (S7). */
	objectStorage: z.array(storageMetricBucketSchema).max(5000).default([]),
	/** Latest per-bucket usage per storage instance. */
	objectStorageBuckets: z.array(storageBucketSnapshotSchema).max(200).default([]),
});
export type TelemetryBatch = z.infer<typeof telemetryBatchSchema>;

export const nodeHeartbeatResponseSchema = z.object({
	ok: z.boolean(),
	desiredStateVersion: z.number().int(),
});
export type NodeHeartbeatResponse = z.infer<typeof nodeHeartbeatResponseSchema>;

export const nodeJoinSchema = z.object({
	token: z.string().min(20),
	name: z.string().min(1).max(120),
	publicAddress: z.string().max(253).optional(),
	version: z.string().max(64).optional(),
});
export type NodeJoin = z.infer<typeof nodeJoinSchema>;

export const deploymentEventSchema = z.object({
	type: z.string(),
	deploymentId: z.string(),
	projectId: z.string(),
	status: z.enum(deploymentStatuses),
	runtime: z.enum(runtimes),
	at: z.string(),
});
export type DeploymentEvent = z.infer<typeof deploymentEventSchema>;

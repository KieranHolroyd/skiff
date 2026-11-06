import * as z from 'zod';
import { nodeStudioDesiredSchema } from './database-studio.ts';
import { nodeHardwareSchema } from './cluster.ts';
import { wireguardStateSchema, wireguardStatusSchema } from './overlay.ts';
import { nodeIdentityCertificateSchema, serviceEndpointSchema, serviceProviderSchema } from './endpoint.ts';
import { databaseStudioPrincipalResultSchema, databaseStudioPrincipalTaskSchema } from './database-studio-principal.ts';
import { accessModes, deploymentStatuses, nodeStatuses, runtimes } from './model.ts';
import { domainKinds } from './domain.ts';
import { workloadDesiredSchema, workloadStatuses } from './workload.ts';
import { databaseMetricBucketSchema, databaseSnapshotSchema } from './database.ts';
import { databaseBackupResultSchema, databaseBackupTaskSchema } from './database-backup.ts';
import { databasePitrResultSchema, databasePitrTaskSchema } from './database-pitr.ts';
import {
	databaseCredentialResultSchema,
	databaseCredentialTaskSchema,
	databaseRotationResultSchema,
	databaseRotationTaskSchema,
} from './database.ts';
import {
	storageBucketConfigReportSchema,
	storageBucketDeletionSchema,
	storageBucketSnapshotSchema,
	storageMetricBucketSchema,
	storageGatewaySchema,
	storageRouteSchema,
} from './object-storage.ts';
import { nodeStorageSchema, nodeStorageStatusSchema } from './storage.ts';
import { nodeVolumeDesiredSchema, volumeInventorySchema } from './volume.ts';

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
	/** Several healthy worker upstreams for a multi-node replica set (C4). */
	upstreams: z.array(z.string()).max(20).optional(),
	/** Health path used by Caddy's active checks across replicas. */
	healthPath: z.string().max(200).optional(),
	/**
	 * Functions only (D110): static assets are served first from the release, with the workerd
	 * host as the fallback (and the target for `runWorkerFirst` globs). Present only on the node
	 * that holds the release; the edge proxies here like any other worker-placed site.
	 */
	function: z
		.object({
			assetsDirectory: z.string().nullable().default(null),
			runWorkerFirst: z.array(z.string()).default([]),
			/**
			 * Phase 4: every replica socket for this route, in order, when a stateless function
			 * runs `replicas > 1`. Caddy load-balances across them. Absent for a single host, whose
			 * `upstream` above is the one target; the edge route never carries `function` and keeps
			 * using `upstream` as before.
			 */
			upstreams: z.array(z.string()).optional(),
		})
		.optional(),
	/**
	 * True for the `<slug>.<contentDomain>` route that follows the production pointer. Production
	 * is served through a per-project symlink (promote = symlink swap); previews are rooted
	 * directly at their immutable release. Older control planes omit it; agents then derive it
	 * from the host.
	 */
	production: z.boolean().optional(),
});
export type RouteSpec = z.infer<typeof routeSpecSchema>;

/** A requested agent/helper update (D99): `generation` changes on every request, including retries. */
export const nodeUpdateTaskSchema = z.object({
	generation: z.number().int().positive(),
	/** Semantic version of the signed release to install, without the `v`. */
	version: z.string().regex(/^\d+\.\d+\.\d+$/),
	/** GitHub repository the signed release is published in (`owner/name`). */
	repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
});
export type NodeUpdateTask = z.infer<typeof nodeUpdateTaskSchema>;

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
	/** Backup dumps and restores this node must execute (docs/DATABASES.md §9). */
	databaseBackupTasks: z.array(databaseBackupTaskSchema).default([]),
	/** pgBackRest base backups, PITR restores and status checks (docs/PITR.md). */
	databasePitrTasks: z.array(databasePitrTaskSchema).default([]),
	/** Credential rotations this node must apply (docs/DATABASES.md §4). */
	databaseRotations: z.array(databaseRotationTaskSchema).default([]),
	/** Named database credentials to grant or revoke (plan 04b). */
	databaseCredentialTasks: z.array(databaseCredentialTaskSchema).default([]),
	/** Read-only studio principals to (re)apply, by generation (plan 22 track G). Never the password. */
	databaseStudioPrincipals: z.array(databaseStudioPrincipalTaskSchema).default([]),
	/** Database ids whose PgBouncer sidecar must be restarted (docs/DATABASES.md §11). */
	databasePoolerRestarts: z.array(z.string()).default([]),
	/** Registered volumes this node must know about, for volume-backed data dirs (D74). */
	volumes: z.array(nodeVolumeDesiredSchema).default([]),
	/** Internal S3 gateway routes the control plane uses to manage object contents (D81). */
	storageGateway: storageGatewaySchema.default({ listen: null, routes: [] }),
	/** Native studio front (plan 22): listen port and live session ids, or null when off. */
	studio: nodeStudioDesiredSchema.nullable().default(null),
	/** Internal gateway route the control plane uses to reach the node's studio front (D96). */
	databaseGateway: storageGatewaySchema.default({ listen: null, routes: [] }),
	/**
	 * Install this signed release's agent and helper (D99). Present while an update an operator
	 * requested is outstanding for this node; the helper verifies the release signature itself.
	 */
	nodeUpdate: nodeUpdateTaskSchema.nullable().default(null),
	/** Managed overlay state for this node (C1); absent on external/pre-C1 nodes. */
	wireguard: wireguardStateSchema.optional(),
	/** Consumer-side loopback endpoints for attached remote services (C2). */
	serviceEndpoints: z.array(serviceEndpointSchema).default([]),
	/** Provider-side overlay listeners for services this node hosts (C2). */
	serviceProviders: z.array(serviceProviderSchema).default([]),
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

/**
 * Capabilities an agent build declares in its heartbeat. Add one whenever the control plane hands
 * out desired-state work an older agent would drop without a word.
 * - `studio-principal`: applies `databaseStudioPrincipals` (plan 22 track G).
 * - `node-update`: installs `nodeUpdate` through the helper's signed-release verb (D99).
 * - `functions`: renders and runs `runtime: "function"` workloads (D110).
 */
export const nodeCapabilities = ['studio-principal', 'node-update', 'functions'] as const;
export type NodeCapability = (typeof nodeCapabilities)[number];

export const heartbeatSchema = z.object({
	nodeId: z.string(),
	agentVersion: z.string(),
	actualStateVersion: z.number().int().nonnegative(),
	status: z.enum(nodeStatuses),
	caddyOk: z.boolean(),
	/**
	 * What this agent build can do (`nodeCapabilities`). Lets the control plane refuse work an older
	 * agent would silently ignore instead of waiting on it. Absent from agents that predate it.
	 */
	capabilities: z.array(z.string().min(1).max(64)).max(32).optional(),
	stats: z.object({
		cpuPercent: z.number().nonnegative(),
		memoryBytes: z.number().int().nonnegative(),
		memoryTotalBytes: z.number().int().nonnegative(),
		diskUsedBytes: z.number().int().nonnegative(),
		diskTotalBytes: z.number().int().nonnegative(),
		/** Free space on the data filesystem; derived from total-used when an older agent omits it. */
		diskFreeBytes: z.number().int().nonnegative().optional(),
		uptimeSeconds: z.number().nonnegative(),
		load1: z.number().nonnegative(),
		/**
		 * TLS certificates this node's Caddy serves, probed locally (DESIGN §8 "cert expiring < 14 d").
		 * `host` is the SNI probed (`*.<contentDomain>` for the wildcard); `notAfter` is ISO 8601.
		 */
		certs: z.array(z.object({ host: z.string().max(253), notAfter: z.string().max(40) })).max(50),
	}).partial().optional(),
	releases: z.array(z.object({ sha256: z.string(), sizeBytes: z.number().int().nonnegative() })).default([]),
	/** Hardware facts, refreshed at start-up and hourly (CLUSTERING §3.1). */
	hardware: nodeHardwareSchema.optional(),
	/** Latest WireGuard peer health, when this node runs a managed overlay (C1). */
	wireguard: wireguardStatusSchema.optional(),
	/** Public node certificate for C2 mTLS; the private key never leaves the node. */
	nodeCertificate: nodeIdentityCertificateSchema.optional(),
	/** What the node's storage service last applied (D48). */
	storage: nodeStorageStatusSchema.optional(),
	/** Mounts and free block devices the node reports for the volume wizard (D72, D80). */
	volumes: volumeInventorySchema.optional(),
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
	/** Outcomes of `databaseBackupTasks` since the last heartbeat. */
	databaseBackupResults: z.array(databaseBackupResultSchema).max(50).optional(),
	/** Outcomes of `databasePitrTasks` since the last heartbeat. */
	databasePitrResults: z.array(databasePitrResultSchema).max(50).optional(),
	/** Outcomes of `databaseRotations` since the last heartbeat. */
	databaseRotationResults: z.array(databaseRotationResultSchema).max(50).optional(),
	/** Outcomes of `databaseCredentialTasks` since the last heartbeat. */
	databaseCredentialResults: z.array(databaseCredentialResultSchema).max(50).optional(),
	/** Outcomes of `databaseStudioPrincipals` since the last heartbeat. */
	databaseStudioPrincipalResults: z.array(databaseStudioPrincipalResultSchema).max(50).optional(),
	/**
	 * A `nodeUpdate` generation that failed. Success needs no report: the restarted agent's
	 * `agentVersion` is the proof (D99).
	 */
	nodeUpdateResult: z.object({
		generation: z.number().int().positive(),
		error: z.string().max(2_000),
	}).optional(),
	/** Database ids whose pooler restart the node completed. */
	databasePoolerRestarted: z.array(z.string()).max(50).optional(),
	/**
	 * Retired with the D60 studio console (D96). 0.7.x agents may still send console results;
	 * they are accepted and ignored. Remove once no 0.7.x agents remain.
	 */
	databaseConsoleResults: z.array(z.unknown()).max(50).optional(),
	/** TLS state derived from the helper's certificate files (CA PEM is public, never a key). */
	databaseTls: z
		.array(
			z.object({
				id: z.string().max(100),
				enabled: z.boolean(),
				caPem: z.string().max(16_384).nullable().optional(),
				error: z.string().max(2_000).nullable().optional(),
			}),
		)
		.max(200)
		.optional(),
	/** Outcomes of `objectStorage.deleteBuckets` entries since the last heartbeat. */
	storageBucketDeletions: z.array(storageBucketDeletionSchema).max(500).optional(),
	/** Bucket configuration convergence outcomes since the last heartbeat. */
	storageBucketConfigs: z.array(storageBucketConfigReportSchema).max(500).optional(),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

/** Pre-aggregated 1-minute access buckets; raw requests never reach the telemetry store (DESIGN §8). */
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

/**
 * One Analytics Engine datapoint from a function (docs/FUNCTIONS.md §4.5). `blobs`/`doubles`/
 * `indexes` are the Workers API arrays; the binding's dataset and the owning project/workload are
 * attached by the node so the dashboard can group without trusting the worker.
 */
export const analyticsEventSchema = z.object({
	ts: z.number().int().nonnegative(),
	projectId: z.string().max(100),
	workloadId: z.string().max(100),
	dataset: z.string().min(1).max(100),
	blobs: z.array(z.string().max(16_384)).max(20).default([]),
	doubles: z.array(z.number()).max(20).default([]),
	indexes: z.array(z.string().max(1024)).max(20).default([]),
});
export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;

/** One tail-worker item for one function invocation (docs/FUNCTIONS.md §4.5, phase 3). */
export const functionTailEventSchema = z.object({
	ts: z.number().int().nonnegative(),
	projectId: z.string().max(100),
	workloadId: z.string().max(100),
	scriptName: z.string().max(200).default(''),
	outcome: z.string().max(64).default('unknown'),
	logs: z
		.array(z.object({ level: z.string().max(16), message: z.string().max(4_096) }))
		.max(50)
		.default([]),
	exceptions: z
		.array(z.object({ name: z.string().max(200), message: z.string().max(4_096) }))
		.max(20)
		.default([]),
	request: z
		.object({
			method: z.string().max(16),
			url: z.string().max(2_048),
			status: z.number().int().nonnegative().optional(),
		})
		.nullable()
		.default(null),
});
export type FunctionTailEvent = z.infer<typeof functionTailEventSchema>;

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
	/** Analytics Engine datapoints written by function bindings (phase 2). */
	analytics: z.array(analyticsEventSchema).max(5000).default([]),
	/** Structured tail-worker items from function invocations (phase 3). */
	tails: z.array(functionTailEventSchema).max(2000).default([]),
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
	/** `skiff` asks the control plane for a managed overlay address. */
	networkMode: z.enum(['skiff', 'external']).default('external'),
	/** Public key generated by the node's helper; the private key never travels. */
	wireguardPublicKey: z.string().trim().regex(/^[A-Za-z0-9+/]{43}=$/).optional(),
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

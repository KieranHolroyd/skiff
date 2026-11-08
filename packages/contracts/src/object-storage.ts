import * as z from 'zod';
import { SLUG_PATTERN } from './slugs.ts';
import { storageTargetSchema, type DiskSummary } from './disk.ts';
import { storageReplicationDesiredSchema } from './storage-replication.ts';

/**
 * Managed object storage (docs/OBJECT-STORAGE.md, S1–S10).
 *
 * A storage instance is an org resource: one RustFS server run as a tier-3 container on one node,
 * holding buckets and serving an S3-compatible API. This module is the engine registry and the
 * wire shapes shared by the control plane, agent and surfaces. Like `database.ts` it imports
 * nothing from `workload.ts`, so `workload.ts` can reference it.
 *
 * Naming: "storage" alone already means node storage locations (`storage.ts`, D48), so wire
 * fields use `objectStorage` / `storageRoutes` / `storagePurges`.
 */

export const storageEngines = ['rustfs'] as const;
export type StorageEngine = (typeof storageEngines)[number];

export interface StorageEngineInfo {
	engine: StorageEngine;
	label: string;
	versions: readonly string[];
	defaultVersion: string;
	/** S3 API port inside the container. */
	containerPort: number;
	minMemoryMb: number;
	defaultMemoryMb: number;
}

/** The registry. The helper keeps its own copy of the image/user mapping on purpose (D61). */
export const storageEngineRegistry: Record<StorageEngine, StorageEngineInfo> = {
	rustfs: {
		engine: 'rustfs',
		label: 'RustFS',
		versions: ['1.0.4'],
		defaultVersion: '1.0.4',
		containerPort: 9000,
		minMemoryMb: 256,
		defaultMemoryMb: 512,
	},
};

/** Host ports allocated per node for storage containers (loopback only). Disjoint from databases. */
export const STORAGE_PORT_MIN = 19000;
export const STORAGE_PORT_MAX = 19999;

/** RustFS accepts any region; SDKs insist on one. */
export const STORAGE_REGION = 'us-east-1';

/** Environment slugs that would make `<slug>--<env>` collide with storage hosts (S3). */
export const STORAGE_RESERVED_ENVIRONMENTS: ReadonlySet<string> = new Set(['s3', 'console']);

export const storageStatuses = ['pending', 'starting', 'running', 'failed', 'stopped'] as const;
export type StorageStatus = (typeof storageStatuses)[number];

export const storageNameSchema = z
	.string()
	.min(3)
	.max(40)
	.regex(SLUG_PATTERN, 'Use lowercase letters, digits and single hyphens; start and end with a letter or digit.')
	.refine((name) => !name.includes('--'), 'Double hyphens are not allowed.');

/**
 * S3 bucket names, narrowed: 3–63 lowercase letters, digits and single hyphens. No dots, so
 * path-style URLs and TLS stay simple, and no `--`, which also rules out the reserved `xn--`
 * prefix and `--ol-s3` / `--x-s3` suffixes.
 */
export const bucketNameSchema = z
	.string()
	.min(3)
	.max(63)
	.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Bucket names use lowercase letters, digits and hyphens, and start and end with a letter or digit.')
	.refine((name) => !name.includes('--'), 'Double hyphens are not allowed in bucket names.')
	.refine((name) => !name.endsWith('-s3alias'), 'Bucket names cannot end with "-s3alias".');

/** Anonymous access to a bucket. `public-read` allows unsigned GETs of objects (not listing). */
export const bucketAccesses = ['private', 'public-read'] as const;
export type BucketAccess = (typeof bucketAccesses)[number];

/** SigV4 caps a presigned URL's lifetime at seven days. */
export const STORAGE_SHARE_MAX_TTL_SECONDS = 604_800;

/** One lifecycle rule. At least one action is required; noncurrent expiry needs versioning. */
export const bucketLifecycleRuleSchema = z
	.object({
		id: z.string().min(1).max(255),
		prefix: z.string().max(1024).optional(),
		/** Expire the current object version after this many days. */
		expireDays: z.number().int().min(1).max(36_500).optional(),
		/** Expire noncurrent versions after this many days (versioned buckets only). */
		noncurrentExpireDays: z.number().int().min(1).max(36_500).optional(),
		/** Abort incomplete multipart uploads after this many days. */
		abortIncompleteDays: z.number().int().min(1).max(36_500).optional(),
		enabled: z.boolean().default(true),
	})
	.superRefine((rule, ctx) => {
		if (rule.expireDays === undefined && rule.noncurrentExpireDays === undefined && rule.abortIncompleteDays === undefined)
			ctx.addIssue({ code: 'custom', message: 'A lifecycle rule needs at least one action (expireDays, noncurrentExpireDays or abortIncompleteDays).' });
	});
export type BucketLifecycleRule = z.infer<typeof bucketLifecycleRuleSchema>;

export const bucketCorsMethods = ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'] as const;
export type BucketCorsMethod = (typeof bucketCorsMethods)[number];

/** One CORS rule (RustFS stores these as S3 CORS rules). */
export const bucketCorsRuleSchema = z.object({
	origin: z.array(z.string().min(1).max(255)).min(1).max(20),
	method: z.array(z.enum(bucketCorsMethods)).min(1).max(bucketCorsMethods.length),
	header: z.array(z.string().min(1).max(255)).max(50).default([]),
	expose: z.array(z.string().min(1).max(255)).max(50).default([]),
	maxAge: z.number().int().min(0).max(86_400).optional(),
});
export type BucketCorsRule = z.infer<typeof bucketCorsRuleSchema>;

/** Object lock is enabled only when the bucket is created and cannot be undone. */
export const bucketObjectLockSchema = z.object({
	mode: z.enum(['governance', 'compliance']),
	retainDays: z.number().int().min(1).max(36_500),
});
export type BucketObjectLock = z.infer<typeof bucketObjectLockSchema>;

/** A hard byte cap; null means unlimited. */
export const bucketQuotaSchema = z.number().int().min(1).max(10_485_760 * 1024 * 1024).nullable();

const bucketLifecycleSchema = z.array(bucketLifecycleRuleSchema).max(100).default([]);
const bucketCorsSchema = z.array(bucketCorsRuleSchema).max(100).default([]);

/** Validate the cross-field rules shared by bucket create and update. */
function refineBucketConfig(
	input: {
		versioning?: boolean;
		lifecycle?: BucketLifecycleRule[];
		cors?: BucketCorsRule[];
		objectLock?: unknown;
	},
	ctx: z.RefinementCtx,
): void {
	if (input.objectLock && !input.versioning)
		ctx.addIssue({ code: 'custom', path: ['objectLock'], message: 'Object lock requires versioning; enable it on the same request.' });
	const lifecycle = input.lifecycle ?? [];
	const ids = new Set<string>();
	for (const [index, rule] of lifecycle.entries()) {
		if (ids.has(rule.id))
			ctx.addIssue({ code: 'custom', path: ['lifecycle', index, 'id'], message: 'Lifecycle rule ids must be unique.' });
		ids.add(rule.id);
		if (rule.noncurrentExpireDays !== undefined && !input.versioning)
			ctx.addIssue({
				code: 'custom',
				path: ['lifecycle', index, 'noncurrentExpireDays'],
				message: 'Noncurrent version expiry requires versioning.',
			});
	}
	const origins = new Set<string>();
	for (const [index, rule] of (input.cors ?? []).entries()) {
		for (const origin of rule.origin) {
			const key = origin.toLowerCase();
			if (origins.has(key))
				ctx.addIssue({ code: 'custom', path: ['cors', index, 'origin'], message: `CORS origin "${origin}" is listed twice.` });
			origins.add(key);
		}
	}
}

export const storageGrantModes = ['read', 'read-write'] as const;
export type StorageGrantMode = (typeof storageGrantModes)[number];

export const storageGrantSchema = z.object({
	bucket: bucketNameSchema,
	mode: z.enum(storageGrantModes).default('read-write'),
});
export type StorageGrant = z.infer<typeof storageGrantSchema>;

export const storageGrantsSchema = z
	.array(storageGrantSchema)
	.min(1, 'Grant at least one bucket.')
	.max(20)
	.refine((grants) => new Set(grants.map((grant) => grant.bucket)).size === grants.length, 'Each bucket may be granted once.');

/** Prefix for injected env vars: `S3` → `S3_ENDPOINT_URL`, `S3_ACCESS_KEY_ID`, … (`AWS` matches the AWS SDKs). */
export const storageEnvPrefixSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Z][A-Z0-9_]*$/, 'Env prefixes must be UPPER_SNAKE_CASE')
	.refine((prefix) => !prefix.endsWith('_'), 'Env prefixes must not end with "_"');

export const storageCreateSchema = z
	.object({
		name: storageNameSchema,
		engine: z.enum(storageEngines).default('rustfs'),
		version: z.string().max(32).optional(),
		/** `auto`, `edge`, or a node id. Resolved once at create time (D41). */
		placement: z.string().min(1).max(64).default('auto'),
		memoryMb: z.number().int().min(128).max(16_384).optional(),
		cpus: z.number().positive().max(8).default(1),
		/** Storage budget used for alerts and the dashboard gauge, in MB. */
		storageMb: z.number().int().min(256).max(10_485_760).default(10_240),
		/** Serve the S3 API at `<name>--s3.<contentDomain>` (S3). */
		public: z.boolean().default(false),
		/** Buckets to create right away (all `private`). */
		buckets: z.array(bucketNameSchema).max(20).default([]),
		/** `system`, `fast`, `bulk` or a disk name; omitted uses the default from Settings → Storage (docs/STORAGE.md). */
		storage: storageTargetSchema.optional(),
		/** Attach to this project right away, read-write on every bucket created here. */
		project: z.string().min(1).max(64).optional(),
		envPrefix: storageEnvPrefixSchema.optional(),
	})
	.superRefine((input, ctx) => {
		const info = storageEngineRegistry[input.engine];
		if (input.version && !info.versions.includes(input.version))
			ctx.addIssue({ code: 'custom', path: ['version'], message: `${info.label} versions: ${info.versions.join(', ')}.` });
		if (input.memoryMb !== undefined && input.memoryMb < info.minMemoryMb)
			ctx.addIssue({ code: 'custom', path: ['memoryMb'], message: `${info.label} needs at least ${info.minMemoryMb} MB.` });
		if (new Set(input.buckets).size !== input.buckets.length)
			ctx.addIssue({ code: 'custom', path: ['buckets'], message: 'Bucket names must be unique.' });
		if (input.project && input.buckets.length === 0)
			ctx.addIssue({ code: 'custom', path: ['buckets'], message: 'Create at least one bucket to attach a project on create.' });
	});
export type StorageCreate = z.input<typeof storageCreateSchema>;

export const storageUpdateSchema = z
	.object({
		memoryMb: z.number().int().min(128).max(16_384).optional(),
		cpus: z.number().positive().max(8).optional(),
		storageMb: z.number().int().min(256).max(10_485_760).optional(),
		public: z.boolean().optional(),
		version: z.string().max(32).optional(),
	})
	.refine((input) => Object.keys(input).length > 0, 'Nothing to update.');
export type StorageUpdate = z.infer<typeof storageUpdateSchema>;

export const bucketCreateSchema = z
	.object({
		name: bucketNameSchema,
		access: z.enum(bucketAccesses).default('private'),
		versioning: z.boolean().default(false),
		lifecycle: bucketLifecycleSchema,
		cors: bucketCorsSchema,
		quotaBytes: bucketQuotaSchema.default(null),
		/** Create-only and irreversible: a versioned bucket with a default retention period. */
		objectLock: bucketObjectLockSchema.nullable().default(null),
	})
	.superRefine(refineBucketConfig);
export type BucketCreate = z.input<typeof bucketCreateSchema>;

/** PATCH semantics: send only the fields that change. Object lock can never be changed. */
export const bucketUpdateSchema = z
	.object({
		access: z.enum(bucketAccesses).optional(),
		versioning: z.boolean().optional(),
		lifecycle: z.array(bucketLifecycleRuleSchema).max(100).optional(),
		cors: z.array(bucketCorsRuleSchema).max(100).optional(),
		quotaBytes: bucketQuotaSchema.optional(),
		objectLock: z
			.unknown()
			.optional()
			.refine((value) => value === undefined, 'Object lock is set when a bucket is created and cannot be changed.'),
	})
	.strict()
	.superRefine(refineBucketConfig)
	.refine((input) => Object.keys(input).length > 0, 'Nothing to update.');
export type BucketUpdate = z.infer<typeof bucketUpdateSchema>;

export const storageAttachSchema = z.object({
	storage: storageNameSchema,
	envPrefix: storageEnvPrefixSchema.default('S3'),
	grants: storageGrantsSchema,
});
export type StorageAttach = z.input<typeof storageAttachSchema>;

export const storageAttachmentUpdateSchema = z.object({ grants: storageGrantsSchema });
export type StorageAttachmentUpdate = z.input<typeof storageAttachmentUpdateSchema>;

/** Named human/service storage keys (plan 04b), independent of project attachments. */
export const storageKeyNameSchema = z
	.string()
	.min(1)
	.max(60)
	.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Key names use lowercase letters, digits and single hyphens.');

export const storageKeyCreateSchema = z.object({
	name: storageKeyNameSchema,
	grants: storageGrantsSchema,
	purpose: z.string().min(1).max(120).optional(),
	expiresAt: z.string().datetime().optional(),
});
export type StorageKeyCreate = z.input<typeof storageKeyCreateSchema>;

export interface StorageKeyView {
	id: string;
	storageId: string;
	name: string;
	accessKeyId: string;
	grants: StorageGrant[];
	purpose: string | null;
	/** `expired` is derived: the row is live but past `expiresAt`. */
	status: 'active' | 'expired' | 'revoked';
	lastUsedAt: string | null;
	expiresAt: string | null;
	createdAt: string;
	revokedAt: string | null;
}

/** A named key plus its secret; only an interactive reveal returns this shape. */
export interface StorageKeyReveal extends StorageKeyView {
	secretAccessKey: string;
}

// -------------------------------------------------------------------- views

export const bucketConfigStatuses = ['pending', 'converged', 'error', 'unsupported'] as const;
export type BucketConfigStatus = (typeof bucketConfigStatuses)[number];

export interface BucketConfig {
	access: BucketAccess;
	versioning: boolean;
	lifecycle: BucketLifecycleRule[];
	cors: BucketCorsRule[];
	quotaBytes: number | null;
	objectLock: BucketObjectLock | null;
	/** Incremented on every desired-state change; the agent reports it back when applied. */
	configVersion: number;
	configStatus: BucketConfigStatus;
	configMessage: string | null;
	lastConvergedAt: string | null;
}

export interface StorageBucketView extends BucketConfig {
	name: string;
	/** `deleting` until the node reports; `delete-blocked` when it was not empty (force or re-create to cancel). */
	state: 'ready' | 'deleting' | 'delete-blocked';
	/** Latest sampled size and object count; null until the agent reports. */
	sizeBytes: number | null;
	objects: number | null;
	createdAt: string;
	statsAt: string | null;
}

export interface StorageAttachmentView {
	storageId: string;
	storageName: string;
	projectId: string;
	projectSlug: string;
	envPrefix: string;
	/** Env var names the project receives at activation. */
	envNames: string[];
	grants: StorageGrant[];
	/** The attachment's own access key id (not secret; the secret key is never shown). */
	accessKeyId: string;
	createdAt: string;
}

export interface StorageView {
	id: string;
	name: string;
	engine: StorageEngine;
	engineLabel: string;
	version: string;
	status: StorageStatus;
	message: string | null;
	nodeId: string;
	nodeName: string | null;
	memoryMb: number;
	cpus: number;
	storageMb: number;
	/** Latest sampled bytes stored across buckets. */
	usedBytes: number | null;
	objects: number | null;
	public: boolean;
	/** `https://<name>--s3.<contentDomain>` when public. */
	publicUrl: string | null;
	/** What an attached app on the same node connects to. */
	internalEndpoint: { process: string; container: string };
	/** Where the data dir lives; null keeps the helper state dir (D74). */
	/** The disk the data lives on; null is the system disk. */
	disk: DiskSummary | null;
	region: string;
	buckets: StorageBucketView[];
	attachments: StorageAttachmentView[];
	/** Root key state; never the secret. `rotating` while a new pair waits for the node (§5). */
	rootKey: StorageRootKeyState;
	statsAt: string | null;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
	purgeAt: string | null;
}

export interface StorageRootKeyState {
	accessKeyId: string;
	status: 'current' | 'rotating' | 'failed';
	/** The new key id while rotating. */
	pendingAccessKeyId: string | null;
	rotationStartedAt: string | null;
	/** Why the last rotation was rolled back. */
	error: string | null;
	rotatedAt: string | null;
}

/** Root key for humans (S6). Every reveal is audited; MCP never returns it. */
export interface StorageCredentials {
	storageId: string;
	name: string;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	/** Public URL when public, else the loopback endpoint on the node. */
	endpoint: string;
	internalEndpoint: string;
	publicEndpoint: string | null;
	note: string;
}

// -------------------------------------------------------------------- node wire

export const storageBucketDesiredSchema = z
	.object({
		name: bucketNameSchema,
		access: z.enum(bucketAccesses),
		versioning: z.boolean().default(false),
		lifecycle: bucketLifecycleSchema,
		cors: bucketCorsSchema,
		quotaBytes: bucketQuotaSchema.default(null),
		objectLock: bucketObjectLockSchema.nullable().default(null),
		/** Bumped by the control plane; the agent echoes it in its convergence report. */
		configVersion: z.number().int().nonnegative().default(1),
		/**
		 * Event notifications (D122): when on, the agent points the bucket's create/delete events at
		 * the instance's `skiff` webhook target; the control plane filters and routes them.
		 */
		notifications: z.boolean().default(false),
	})
	.superRefine(refineBucketConfig);

export const storageUserDesiredSchema = z.object({
	accessKeyId: z.string().min(3).max(128),
	grants: z.array(storageGrantSchema).max(20),
});
export type StorageUserDesired = z.infer<typeof storageUserDesiredSchema>;

/**
 * The `objectStorage` profile on a workload. The helper uses only `engine` + `version` (it derives
 * image, user, mounts and port itself). `buckets` and `users` are desired state the agent converges
 * over the S3/admin API with the root key; nothing here is secret. `keysVersion` changes whenever a
 * user's secret changes, telling the agent to re-fetch activation without restarting the container.
 */
export const workloadObjectStorageSchema = z.object({
	engine: z.enum(storageEngines),
	version: z.string().min(1).max(32),
	buckets: z.array(storageBucketDesiredSchema).max(200).default([]),
	users: z.array(storageUserDesiredSchema).max(200).default([]),
	/**
	 * Buckets deleted in Skiff. The agent never deletes a bucket just because it is missing from
	 * `buckets` (a transient desired-state bug must not wipe data, as D59). `force` empties it first;
	 * otherwise a non-empty bucket is left alone and reported as blocked.
	 */
	deleteBuckets: z.array(z.object({ name: bucketNameSchema, force: z.boolean().default(false) })).max(200).default([]),
	keysVersion: z.string().length(64),
	/**
	 * Replication links this node runs for the instance (§12). Each link's scoped secret arrives in
	 * `storageAdmin.replication`; `keysVersion` moves when a link is added or removed.
	 */
	replication: z.array(storageReplicationDesiredSchema).max(10).default([]),
});
export type WorkloadObjectStorage = z.infer<typeof workloadObjectStorageSchema>;

/** Activation extras for a storage instance; kept in agent memory only, never sent to the helper. */
export const storageAdminSchema = z.object({
	rootAccessKeyId: z.string(),
	rootSecretAccessKey: z.string(),
	port: z.number().int().positive(),
	keysVersion: z.string().length(64),
	/** Secret keys for `objectStorage.users`, by access key id. */
	users: z.record(z.string(), z.string()).default({}),
	/** Secret of each replication link's scoped key on the peer, by link id. */
	replication: z.record(z.string(), z.string()).default({}),
});
export type StorageAdmin = z.infer<typeof storageAdminSchema>;

/**
 * A public storage endpoint (S3). Not a site: no release, no forward_auth, no site config. Caddy
 * proxies byte-for-byte to `upstream` (`127.0.0.1:<port>` locally, `http://<node>` from the edge).
 */
export const storageRouteSchema = z.object({
	storageId: z.string(),
	host: z.string(),
	upstream: z.string(),
});
export type StorageRoute = z.infer<typeof storageRouteSchema>;

/** One instance's 1-minute sample (S7). `bucket` is the time bucket, as in every telemetry schema. */
export const storageMetricBucketSchema = z.object({
	storageId: z.string().max(100),
	bucket: z.string(),
	up: z.boolean(),
	usedBytes: z.number().int().nonnegative().default(0),
	objects: z.number().int().nonnegative().default(0),
	bucketCount: z.number().int().nonnegative().default(0),
	memoryBytes: z.number().int().nonnegative().default(0),
});
export type StorageMetricBucket = z.infer<typeof storageMetricBucketSchema>;

/** Latest per-bucket usage for one instance (only the newest is kept). */
export const storageBucketSnapshotSchema = z.object({
	storageId: z.string().max(100),
	at: z.string(),
	buckets: z
		.array(
			z.object({
				name: z.string().max(63),
				sizeBytes: z.number().nonnegative(),
				objects: z.number().nonnegative(),
			}),
		)
		.max(200),
});
export type StorageBucketSnapshot = z.infer<typeof storageBucketSnapshotSchema>;

/** Point returned by `GET /storage/:name/metrics`. */
export interface StorageMetricPoint {
	bucket: string;
	up: number;
	usedBytes: number;
	objects: number;
	bucketCount: number;
	memoryBytes: number;
}

// -------------------------------------------------------------------- helpers

/**
 * Which root key the node's agent last proved against a running instance (§5, staged rotation).
 * `accepted`: an admin call signed with `accessKeyId` succeeded; `rejected`: RustFS refused it.
 */
export const storageRootKeyReportSchema = z.object({
	storageId: z.string().max(100),
	accessKeyId: z.string().max(128),
	result: z.enum(['accepted', 'rejected']),
	message: z.string().max(500).nullable().default(null),
});
export type StorageRootKeyReport = z.infer<typeof storageRootKeyReportSchema>;

/** Heartbeat report for one `deleteBuckets` entry. */
export const storageBucketDeletionSchema = z.object({
	storageId: z.string(),
	bucket: z.string(),
	/** `deleted` (or already gone) drops the row; `not-empty` leaves it for a human to force. */
	result: z.enum(['deleted', 'not-empty']),
});
export type StorageBucketDeletion = z.infer<typeof storageBucketDeletionSchema>;

/** What the agent last achieved for one bucket's desired configuration. */
export const storageBucketConfigReportSchema = z.object({
	storageId: z.string(),
	bucket: z.string(),
	configVersion: z.number().int().nonnegative(),
	status: z.enum(bucketConfigStatuses),
	message: z.string().max(500).nullable().default(null),
});
export type StorageBucketConfigReport = z.infer<typeof storageBucketConfigReportSchema>;

/** Access key ids Skiff mints: `SKF` + 17 base32 chars (root keys use `SKR`). The agent owns `SKF*` users. */
export const STORAGE_USER_KEY_PREFIX = 'SKF';
export const STORAGE_ROOT_KEY_PREFIX = 'SKR';

/** Workload ids of storage instances carry this prefix. */
export const STORAGE_ID_PREFIX = 'st_';

/** `s3-<hex>`: the container's DNS alias on the workload's org network (or the legacy shared network). */
export function storageAlias(id: string): string {
	return `s3-${id.replace(/^st_/, '').toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
}

/** Public host for an instance (S3): one label, covered by the content wildcard certificate. */
export function storagePublicHost(name: string, contentDomain: string): string {
	return `${name}--s3.${contentDomain}`;
}

/**
 * Internal host the control plane uses to reach an instance's S3 API through the node gateway
 * (D82). It is never in public DNS: the edge serves it on a loopback listener, and a worker's
 * Caddy serves it on the WireGuard-only app port.
 */
export const STORAGE_GATEWAY_SUFFIX = 'storage.internal';

export function storageGatewayHost(id: string): string {
	const label = id.replace(/^st_/, '').toLowerCase().replace(/[^a-z0-9-]/g, '');
	return `s3-${label}.${STORAGE_GATEWAY_SUFFIX}`;
}

/** One internal gateway route. `upstream` is loopback on the instance's node, or the worker Caddy. */
export const storageGatewayRouteSchema = z.object({
	host: z.string().min(1).max(253),
	upstream: z.string().min(1).max(300),
});
export type StorageGatewayRoute = z.infer<typeof storageGatewayRouteSchema>;

/**
 * The node's gateway: the edge gets a loopback listener for every instance (local and remote);
 * a worker gets its own routes on the WireGuard-only main server (`listen` is null).
 */
export const storageGatewaySchema = z.object({
	listen: z.string().max(200).nullable().default(null),
	routes: z.array(storageGatewayRouteSchema).max(200).default([]),
});
export type StorageGateway = z.infer<typeof storageGatewaySchema>;

// -------------------------------------------------------------------- objects

/**
 * S3 object keys. Slashes are allowed (they are prefixes, not filesystem paths); a leading
 * slash, `.`/`..` segments and control characters are refused so a dashboard action can never
 * escape the bucket or confuse a client.
 */
export const storageObjectKeySchema = z
	.string()
	.min(1)
	.max(1024)
	.refine((key) => !key.startsWith('/'), 'Object keys cannot start with "/".')
	.refine((key) => !key.includes('\0'), 'Object keys cannot contain NUL bytes.')
	.refine((key) => !key.split('/').some((part) => part === '.' || part === '..'), 'Object keys cannot contain "." or ".." segments.')
	.refine((key) => !key.includes('//'), 'Object keys cannot contain "//".');

export interface StorageObject {
	key: string;
	sizeBytes: number;
	etag: string | null;
	lastModified: string | null;
	storageClass: string | null;
}

export interface StorageObjectStat extends StorageObject {
	contentType: string | null;
}

export interface StorageObjectList {
	bucket: string;
	prefix: string;
	delimiter: string;
	objects: StorageObject[];
	/** Folder-like prefixes when a delimiter is used. */
	prefixes: string[];
	isTruncated: boolean;
	nextToken: string | null;
}

export const storageObjectDeleteSchema = z.object({
	keys: z.array(storageObjectKeySchema).min(1).max(1000),
});
export type StorageObjectDelete = z.infer<typeof storageObjectDeleteSchema>;

export const storageFolderSchema = z.object({
	prefix: z
		.string()
		.min(1)
		.max(1024)
		.refine((prefix) => !prefix.startsWith('/'), 'Folder prefixes cannot start with "/".')
		.refine((prefix) => !prefix.includes('\0'), 'Folder prefixes cannot contain NUL bytes.')
		.transform((prefix) => (prefix.endsWith('/') ? prefix : `${prefix}/`)),
});
export type StorageFolder = z.infer<typeof storageFolderSchema>;

export const storagePresignSchema = z.object({
	key: storageObjectKeySchema,
	method: z.enum(['GET', 'PUT']).default('GET'),
	/** Seconds; S3 allows up to 7 days. */
	expiresIn: z.number().int().min(60).max(604_800).default(3600),
});
export type StoragePresign = z.infer<typeof storagePresignSchema>;

/**
 * A share link. GET and PUT are presigned server-side with the instance's root key; the browser
 * only ever sees the signature, never a key. `maxDownloads` is enforced by the platform gateway.
 */
export const storageShareLinkSchema = z.object({
	key: storageObjectKeySchema,
	method: z.enum(['GET', 'PUT']).default('GET'),
	/** Seconds; SigV4 allows up to seven days. */
	expiresIn: z.number().int().min(60).max(STORAGE_SHARE_MAX_TTL_SECONDS).default(3600),
	maxDownloads: z.number().int().min(1).max(100_000).optional(),
});
export type StorageShareLinkRequest = z.infer<typeof storageShareLinkSchema>;

export interface StorageShareLink {
	url: string;
	method: 'GET' | 'PUT';
	expiresIn: number;
	expiresAt: string;
	maxDownloads: number | null;
	/** True when the URL goes straight to a public S3 endpoint instead of the platform gateway. */
	direct: boolean;
}

/** Env var names a project receives for one attachment. */
export function storageEnvNames(prefix: string, options: { public: boolean; singleBucket: boolean }): string[] {
	const names = ['ENDPOINT_URL', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'REGION', 'FORCE_PATH_STYLE'];
	if (options.public) names.splice(1, 0, 'PUBLIC_ENDPOINT_URL');
	if (options.singleBucket) names.push('BUCKET');
	return names.map((suffix) => `${prefix}_${suffix}`);
}

/** OCI image for an engine version. The helper has its own pinned copy and rejects any mismatch. */
export function storageImage(engine: StorageEngine, version: string): string {
	switch (engine) {
		case 'rustfs':
			return `docker.io/rustfs/rustfs:${version}`;
	}
}

/** Canned IAM policy name for one access key (the agent owns policies with this prefix). */
export function storagePolicyName(accessKeyId: string): string {
	return `skiff-${accessKeyId.toLowerCase()}`;
}

const READ_ACTIONS = ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket', 's3:GetBucketLocation'];
const WRITE_ACTIONS = [
	's3:PutObject',
	's3:DeleteObject',
	's3:DeleteObjectVersion',
	's3:AbortMultipartUpload',
	's3:ListMultipartUploadParts',
	's3:ListBucketMultipartUploads',
];

/** IAM policy document for a scoped key (S4): object and listing access to the granted buckets only. */
export function storageUserPolicy(grants: readonly StorageGrant[]): Record<string, unknown> {
	return {
		Version: '2012-10-17',
		Statement: grants.map((grant) => ({
			Effect: 'Allow',
			Action: grant.mode === 'read-write' ? [...READ_ACTIONS, ...WRITE_ACTIONS] : READ_ACTIONS,
			Resource: [`arn:aws:s3:::${grant.bucket}`, `arn:aws:s3:::${grant.bucket}/*`],
		})),
	};
}

/** Bucket policy for `public-read`: unsigned GET of objects, no listing. */
export function publicReadBucketPolicy(bucket: string): Record<string, unknown> {
	return {
		Version: '2012-10-17',
		Statement: [
			{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/*`] },
		],
	};
}

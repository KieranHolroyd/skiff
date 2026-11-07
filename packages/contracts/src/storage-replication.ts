import * as z from 'zod';

/** Object-storage bucket replication (docs/CLUSTERING.md §10.2, C9). */
export const storageReplicationStatuses = [
	'pending',
	'linking',
	'syncing',
	'protected',
	'lagging',
	'failed',
	'stopped',
] as const;
export type StorageReplicationStatus = (typeof storageReplicationStatuses)[number];

export const storageReplicationSchema = z.object({
	id: z.string().min(1).max(100),
	sourceId: z.string().min(1).max(100),
	targetId: z.string().min(1).max(100),
	mode: z.literal('bucket').default('bucket'),
	status: z.enum(storageReplicationStatuses),
	lastSyncAt: z.string().max(40).nullable().default(null),
	lagSeconds: z.number().nonnegative().nullable().default(null),
});
export type StorageReplication = z.infer<typeof storageReplicationSchema>;

export const storageReplicationCreateSchema = z
	.object({
		target: z.string().trim().min(3).max(40),
		mode: z.literal('bucket').default('bucket'),
	})
	.strict();
export type StorageReplicationCreate = z.input<typeof storageReplicationCreateSchema>;

/** Per-bucket progress the runner reports. */
export const storageReplicationBucketReportSchema = z.object({
	name: z.string().min(1).max(63),
	/** `in-sync` once a full pass found nothing left to copy or delete. */
	status: z.enum(['syncing', 'in-sync', 'error']),
	/** Objects (or deletes) still to apply after the latest pass. */
	pending: z.number().int().nonnegative().default(0),
	/** Start of the latest pass that finished with nothing pending. */
	lastSyncAt: z.string().max(40).nullable().default(null),
	error: z.string().max(500).nullable().default(null),
});
export type StorageReplicationBucketReport = z.infer<typeof storageReplicationBucketReportSchema>;

export interface StorageReplicationView extends StorageReplication {
	sourceName: string | null;
	targetName: string | null;
	/** Node whose agent copies the objects (the source's, unless the target is on the edge). */
	runnerNodeId: string | null;
	lastError: string | null;
	lastAttemptAt: string | null;
	/** First complete pass; until then the target is not a usable copy. */
	initialSyncAt: string | null;
	pendingObjects: number | null;
	objectsCopied: number;
	bytesCopied: number;
	buckets: StorageReplicationBucketReport[];
}

// -------------------------------------------------------------------- node wire

/**
 * One replication link the node runs (desired state, no secrets). `push` reads the local instance
 * over loopback and writes the peer; `pull` reads the peer and writes the local instance. The peer
 * is always reached through its node's internal gateway (`endpoint` + `host`, D82) with the rule's
 * own scoped key, never the peer's root key.
 */
export const storageReplicationDesiredSchema = z.object({
	id: z.string().min(1).max(100),
	direction: z.enum(['push', 'pull']),
	/** Peer storage instance id. */
	peerId: z.string().min(1).max(100),
	/** `http://<node address>` of the peer's node gateway. */
	endpoint: z.string().min(1).max(300),
	/** `s3-<id>.storage.internal`, signed and sent as Host. */
	host: z.string().min(1).max(300),
	accessKeyId: z.string().min(3).max(128),
	buckets: z.array(z.string().min(3).max(63)).max(20),
	/** Seconds between full passes (cluster `storage.syncIntervalMinutes`). */
	intervalSeconds: z.number().int().min(60).max(86_400),
	/** Mirror deletes: objects missing on the source are deleted on the target. */
	deletes: z.boolean().default(true),
});
export type StorageReplicationDesired = z.infer<typeof storageReplicationDesiredSchema>;

/** Heartbeat report for one link. */
export const storageReplicationReportSchema = z.object({
	id: z.string().min(1).max(100),
	status: z.enum(['syncing', 'in-sync', 'error']),
	/** Start of the latest pass that finished with every bucket in sync. */
	lastSyncAt: z.string().max(40).nullable().default(null),
	attemptAt: z.string().max(40),
	pending: z.number().int().nonnegative().default(0),
	/** Copied since the previous report (the control plane keeps the running total). */
	copiedObjects: z.number().int().nonnegative().default(0),
	copiedBytes: z.number().int().nonnegative().default(0),
	error: z.string().max(500).nullable().default(null),
	buckets: z.array(storageReplicationBucketReportSchema).max(20).default([]),
});
export type StorageReplicationReport = z.infer<typeof storageReplicationReportSchema>;

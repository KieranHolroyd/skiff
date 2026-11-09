import * as z from 'zod';

/**
 * Postgres streaming replication between nodes (docs/CLUSTERING.md §9.2, C7): the agent/helper
 * wire shapes. The replication password never rides desired state: the primary's agent fetches it
 * from `GET /api/agent/database-replication/:databaseId`, the replica's from its workload
 * activation.
 */

/** The `LOGIN REPLICATION` role on a primary; it can stream WAL and nothing else. */
export const DATABASE_REPLICATION_USER = 'yoal_repl';

/** The heartbeat capability an agent needs before it is handed replica work (`nodeCapabilities`). */
export const DATABASE_REPLICAS_CAPABILITY = 'database-replicas';

/** Where the walreceiver finds its upstream inside a replica container (the agent's link socket). */
export const DATABASE_REPLICA_UPSTREAM_DIR = '/run/yoal-upstream';

/** How often the primary's agent samples `pg_replication_slots` ⋈ `pg_stat_replication`. */
export const DATABASE_REPLICATION_SAMPLE_SECONDS = 30;

/** A slot report older than this counts as stale: promotion then needs `acceptDataLoss`. */
export const DATABASE_REPLICA_REPORT_STALE_SECONDS = 120;

/** Physical slot names Yoal owns; the helper never touches a slot outside this pattern. */
export const DATABASE_REPLICATION_SLOT_PATTERN = /^yoal_[a-z0-9_]{1,56}$/;

/** Most replicas a primary serves (`max_wal_senders` / `max_replication_slots` default to 10). */
export const DATABASE_REPLICATION_MAX_SLOTS = 8;

/** Replay lag that turns `streaming` into `lagging` (the §9.2 warn thresholds). */
export const DATABASE_REPLICA_LAG_WARN_SECONDS = 30;
export const DATABASE_REPLICA_LAG_WARN_BYTES = 256 * 1024 * 1024;

/** Promotion without `acceptDataLoss` needs a replica within this budget (§9.3). */
export const DATABASE_PROMOTION_MAX_LAG_BYTES = 64 * 1024 * 1024;
export const DATABASE_PROMOTION_MAX_LAG_SECONDS = 60;

const slotSchema = z.string().regex(DATABASE_REPLICATION_SLOT_PATTERN);

/** The primary's node keeps the role, `pg_hba` rule and these slots, and drops other `yoal_*` slots. */
export const databaseReplicationTaskSchema = z.object({
	databaseId: z.string().min(1).max(100),
	/** Hash of slots + secret; a new value means "configure again". */
	version: z.string().min(1).max(128),
	/** Empty means tear everything down (role, rule, slots). */
	slots: z.array(slotSchema).max(DATABASE_REPLICATION_MAX_SLOTS).default([]),
});
export type DatabaseReplicationTask = z.infer<typeof databaseReplicationTaskSchema>;

export const databaseReplicationActivationSchema = z.object({
	databaseId: z.string().min(1).max(100),
	version: z.string().min(1).max(128),
	slots: z.array(slotSchema).max(DATABASE_REPLICATION_MAX_SLOTS),
	/** Null when tearing down: the role is dropped, so no password is needed. */
	password: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/).nullable(),
});
export type DatabaseReplicationActivation = z.infer<typeof databaseReplicationActivationSchema>;

/** One `yoal_*` slot as the primary sees it (`pg_replication_slots` ⟕ `pg_stat_replication`). */
export const databaseReplicationSlotStatusSchema = z.object({
	slot: slotSchema,
	active: z.boolean(),
	/** `reserved`, `extended`, `unreserved` or `lost`. */
	walStatus: z.string().max(32).nullable().default(null),
	/** The walsender state (`startup`, `catchup`, `streaming`, …); null while disconnected. */
	state: z.string().max(32).nullable().default(null),
	sentLsn: z.string().max(64).nullable().default(null),
	replayLsn: z.string().max(64).nullable().default(null),
	lagBytes: z.number().int().nonnegative().nullable().default(null),
	lagSeconds: z.number().nonnegative().nullable().default(null),
	syncState: z.string().max(32).nullable().default(null),
});
export type DatabaseReplicationSlotStatus = z.infer<typeof databaseReplicationSlotStatusSchema>;

/** Heartbeat: the latest configure outcome and slot sample for one primary. */
export const databaseReplicationReportSchema = z.object({
	databaseId: z.string().min(1).max(100),
	/** The task version last applied successfully; null when it never was. */
	appliedVersion: z.string().max(128).nullable().default(null),
	error: z.string().max(2_000).nullable().default(null),
	/** Null when the sample failed (the primary is not running, for example). */
	slots: z.array(databaseReplicationSlotStatusSchema).max(32).nullable().default(null),
	sampledAt: z.string().max(40),
});
export type DatabaseReplicationReport = z.infer<typeof databaseReplicationReportSchema>;

/**
 * Where a replica's walreceiver reaches its primary. The agent serves a unix socket at
 * `<replication dir>/<workloadId>/.s.PGSQL.5432`, which the helper bind-mounts into the replica
 * container, and pipes it to the primary's loopback port (same node) or to the primary node's
 * pinned-mTLS provider listener over the overlay (another node).
 */
export const databaseReplicaLinkSchema = z.object({
	workloadId: z.string().min(1).max(100),
	databaseId: z.string().min(1).max(100),
	upstream: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('local'), port: z.number().int().min(1).max(65_535) }),
		z.object({
			kind: z.literal('remote'),
			nodeId: z.string().min(1).max(100),
			/** The primary node's overlay address; null until it is known (the link refuses). */
			address: z.string().max(64).nullable(),
			port: z.number().int().min(1).max(65_535),
			/** The primary node's certificate fingerprint for the mTLS pin. */
			tlsFingerprint: z.string().max(128).nullable(),
		}),
	]),
});
export type DatabaseReplicaLink = z.infer<typeof databaseReplicaLinkSchema>;

/** Promote a replica in place, then hand its data dir to the database's own id (§9.3). */
export const databaseReplicaPromotionTaskSchema = z.object({
	failoverId: z.string().min(1).max(100),
	databaseId: z.string().min(1).max(100),
	replicaWorkloadId: z.string().min(1).max(100),
});
export type DatabaseReplicaPromotionTask = z.infer<typeof databaseReplicaPromotionTaskSchema>;

export const databaseReplicaPromotionResultSchema = z.object({
	failoverId: z.string().min(1).max(100),
	status: z.enum(['ok', 'failed']),
	/** `pg_current_wal_lsn()` right after the promotion, when it succeeded. */
	lsn: z.string().max(64).nullable().optional(),
	error: z.string().max(2_000).optional(),
});
export type DatabaseReplicaPromotionResult = z.infer<typeof databaseReplicaPromotionResultSchema>;

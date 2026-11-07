import * as z from 'zod';

/** Managed database replicas (docs/CLUSTERING.md §9, C7). */
export const databaseReplicaStatuses = ['pending', 'streaming', 'lagging', 'lost', 'failed', 'stopped'] as const;
export type DatabaseReplicaStatus = (typeof databaseReplicaStatuses)[number];

/** Replication modes. Only `async` is implemented; `sync` is refused until its downgrade logic exists. */
export const databaseReplicaModes = ['async', 'sync'] as const;
export type DatabaseReplicaMode = (typeof databaseReplicaModes)[number];

export const databaseReplicaSchema = z.object({
	id: z.string().min(1).max(100),
	databaseId: z.string().min(1).max(100),
	nodeId: z.string().min(1).max(100),
	status: z.enum(databaseReplicaStatuses),
	replayLsn: z.string().max(64).nullable().default(null),
	lagBytes: z.number().int().nonnegative().nullable().default(null),
	lagSeconds: z.number().nonnegative().nullable().default(null),
	slot: z.string().max(100).nullable().default(null),
	primaryGeneration: z.number().int().nonnegative().default(0),
});
export type DatabaseReplica = z.infer<typeof databaseReplicaSchema>;

/** What every surface shows for one replica. */
export interface DatabaseReplicaView extends DatabaseReplica {
	nodeName: string | null;
	zone: string | null;
	/** The replica's container id on its node (`db_<replica id>`). */
	workloadId: string;
	mode: DatabaseReplicaMode;
	/** Loopback port the replica publishes on its node (read-only connections). */
	hostPort: number | null;
	volumeId: string | null;
	/** True when the replica shares the primary's node: read scaling only, no protection from node loss. */
	sameNode: boolean;
	/** Last problem the primary or the replica node reported, if any. */
	message: string | null;
	/** Set once a delete was requested; the row goes away when the slot and data dir are gone. */
	removing: boolean;
	/** When the primary last reported this replica's slot (ISO 8601). */
	reportedAt: string | null;
	createdAt: string;
}

/**
 * One promotion of a replica to primary (docs/CLUSTERING.md §9.3), from `database_failovers`.
 * `fencing` waits for the old primary's node to stop it (or is skipped when that node is gone),
 * `promoting` waits for the replica's node to run `pg_ctl promote` and hand the data directory
 * over, `repointing` waits for the database to report running on its new node.
 */
export const databaseFailoverStages = ['fencing', 'promoting', 'repointing', 'completed', 'failed'] as const;
export type DatabaseFailoverStage = (typeof databaseFailoverStages)[number];

export interface DatabaseFailoverView {
	id: string;
	databaseId: string;
	replicaId: string | null;
	fromNodeId: string | null;
	fromNodeName: string | null;
	toNodeId: string;
	toNodeName: string | null;
	/** The primary generation this promotion creates. */
	generation: number;
	stage: DatabaseFailoverStage;
	reason: string | null;
	/** The error when it failed. */
	message: string | null;
	startedAt: string;
	finishedAt: string | null;
}

/** A promotion candidate and why it was refused. */
export interface DatabasePromotionChoice {
	replica: DatabaseReplica | null;
	reason: string;
	refusals: Array<{ id: string; nodeId: string; reason: string }>;
}

/** Statuses a replica can serve reads from. */
export function databaseReplicaReadable(status: DatabaseReplicaStatus): boolean {
	return status === 'streaming' || status === 'lagging';
}

/** The container id a replica runs under on its node. The helper's database profile needs `db_`. */
export function databaseReplicaWorkloadId(replicaId: string): string {
	return `db_${replicaId}`;
}

/** Replica workload ids are `db_dbr_<hex>`; the database service skips them. */
export const DATABASE_REPLICA_WORKLOAD_PREFIX = 'db_dbr_';

export function isDatabaseReplicaWorkloadId(id: string): boolean {
	return id.startsWith(DATABASE_REPLICA_WORKLOAD_PREFIX) && id.length > DATABASE_REPLICA_WORKLOAD_PREFIX.length;
}

/** The replica row id for a replica workload id (`db_dbr_x` → `dbr_x`). */
export function databaseReplicaIdFromWorkload(id: string): string {
	return id.slice('db_'.length);
}

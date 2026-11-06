import * as z from 'zod';

/** Managed database replicas (docs/CLUSTERING.md §9, C7). */
export const databaseReplicaStatuses = ['pending', 'streaming', 'lagging', 'lost', 'failed', 'stopped'] as const;
export type DatabaseReplicaStatus = (typeof databaseReplicaStatuses)[number];

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

/** A promotion candidate and why it was refused. */
export interface DatabasePromotionChoice {
	replica: DatabaseReplica | null;
	reason: string;
	refusals: Array<{ id: string; nodeId: string; reason: string }>;
}

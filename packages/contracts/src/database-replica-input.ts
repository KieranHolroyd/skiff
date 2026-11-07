import * as z from 'zod';

/** Create a managed database replica (C7). */
export const databaseReplicaCreateSchema = z
	.object({
		node: z.string().trim().min(1).max(100),
		mode: z.enum(['async', 'sync']).default('async'),
		volume: z.string().trim().min(3).max(40).optional(),
	})
	.strict();
export type DatabaseReplicaCreate = z.input<typeof databaseReplicaCreateSchema>;

/**
 * Promote a replica to primary (docs/CLUSTERING.md §9.3). Destructive for the old primary, so the
 * caller must confirm; `acceptDataLoss` is required when the replica is behind the 64 MB / 60 s
 * budget or its last report is stale. Never exposed over MCP.
 */
export const databaseReplicaPromoteSchema = z
	.object({
		confirm: z.literal(true, { message: 'Promotion needs confirm: true.' }),
		acceptDataLoss: z.boolean().default(false),
	})
	.strict();
export type DatabaseReplicaPromote = z.input<typeof databaseReplicaPromoteSchema>;

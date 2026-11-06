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

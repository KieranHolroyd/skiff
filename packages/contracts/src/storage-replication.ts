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

export interface StorageReplicationView extends StorageReplication {
	sourceName: string | null;
	targetName: string | null;
}

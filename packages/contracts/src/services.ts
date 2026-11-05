import * as z from 'zod';
import { databaseNameSchema } from './database.ts';
import { storageNameSchema } from './object-storage.ts';

/**
 * Bulk actions over managed services (databases and object-storage instances). These are fast,
 * desired-state operations: each item bumps its restart generation (or queues a backup), so the
 * node does the work on its next pull. The response is a per-item result, not a long-running
 * operation.
 */

export const serviceRestartScopes = ['all', 'databases', 'storage'] as const;
export type ServiceRestartScope = (typeof serviceRestartScopes)[number];

export const serviceRestartSchema = z
	.object({
		scope: z.enum(serviceRestartScopes).default('all'),
		/** Explicit database names; when present, `scope` is ignored for databases. */
		databases: z.array(databaseNameSchema).max(100).optional(),
		/** Explicit storage instance names; when present, `scope` is ignored for storage. */
		storage: z.array(storageNameSchema).max(100).optional(),
	})
	.refine(
		(input) => input.databases !== undefined || input.storage !== undefined || input.scope !== undefined,
		'Choose a scope or at least one name.',
	);
export type ServiceRestart = z.input<typeof serviceRestartSchema>;

export interface ServiceActionSkip {
	kind: 'database' | 'storage';
	name: string;
	reason: string;
}

export interface ServiceRestartResult {
	restarted: { databases: string[]; storage: string[] };
	skipped: ServiceActionSkip[];
}

export interface DatabaseBackupAllResult {
	queued: string[];
	skipped: ServiceActionSkip[];
}

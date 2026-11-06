import * as z from 'zod';

/**
 * Moving a service to another node (D97). Apps are re-placed and restarted on the target; managed
 * databases go through stop → final dump → restore on the target → purge the old copy.
 */
export const serviceMoveSchema = z.object({
	/** Target node id. */
	node: z.string().min(1).max(64),
	/** Databases only: a volume on the target node; omitted uses the target's default volume. */
	volume: z.string().min(3).max(40).optional(),
	/**
	 * Databases only: where the target's data comes from. `dump` (default) takes a final backup of
	 * the running database. For one that is failed, stopped or on an offline node, `latest-backup`
	 * restores its newest good backup (later writes are lost) and `empty` starts it fresh (its data
	 * is discarded). The old copy is purged once the target is up, as with a dump.
	 */
	from: z.enum(['dump', 'latest-backup', 'empty']).default('dump'),
});
export type ServiceMove = z.input<typeof serviceMoveSchema>;

export const databaseMovePhases = ['quiescing', 'dumping', 'restoring', 'purging', 'done', 'failed'] as const;
export type DatabaseMovePhase = (typeof databaseMovePhases)[number];

export interface DatabaseMoveView {
	id: string;
	databaseId: string;
	databaseName: string;
	phase: DatabaseMovePhase;
	/** Where the target's data came from. */
	from: 'dump' | 'latest-backup' | 'empty';
	/** `moved` once the target serves the data; `rolled_back` when a failed restore returned it. */
	outcome: 'moved' | 'rolled_back' | null;
	source: { nodeId: string; name: string | null };
	target: { nodeId: string; name: string | null };
	/** Slugs of attached projects that stop for the move and restart next to the database. */
	projects: string[];
	backupId: string | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
	/**
	 * Only on the response that starts a move: services attached apps also use that stay on the old
	 * node for now. Those apps cannot reach them (or deploy) until they move too.
	 */
	warnings?: string[];
}

/** A storage instance moves empty (objects are not copied); buckets, keys and attachments come back. */
export interface StorageMoveResult {
	storage: string;
	from: { nodeId: string; name: string | null };
	to: { nodeId: string; name: string | null };
	/** Attached apps that moved with it. */
	projects: string[];
	warnings: string[];
}

export interface AppMoveResult {
	project: string;
	from: { nodeId: string; name: string | null };
	to: { nodeId: string; name: string | null };
}

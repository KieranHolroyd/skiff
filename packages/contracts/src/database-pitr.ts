import * as z from 'zod';
import { databaseEngines } from './database.ts';
import { databaseRestoreSchema } from './database-backup.ts';

/**
 * Point-in-time recovery for managed databases (docs/PITR.md).
 *
 * The data path is pgBackRest on the database's node. A PITR-enabled Postgres 18 database runs the
 * Skiff-built `skiff-postgres-pitr` image (`postgresPitrImage`), whose `archive_command` pushes WAL
 * to an S3-compatible repository; weekly full / daily differential base backups and the status
 * check run inside that container, and a restore runs one-shot containers of the same image.
 * Restores always create a NEW database; in-place is out of scope.
 *
 * Repository credentials never enter desired state or a view. The agent fetches them from the
 * node-authenticated activation endpoint; the helper writes the pgBackRest config as 0400 files
 * under `/run/skiff-workloads/<id>/pgbackrest/`.
 */

export const DATABASE_PITR_FORMAT = 'pgbackrest' as const;
export const pitrBaseBackupTypes = ['full', 'diff', 'incr'] as const;
export type PitrBaseBackupType = (typeof pitrBaseBackupTypes)[number];

/** Weekly full, daily differential outside Sunday. Both at 02:00 UTC. */
export const PITR_FULL_SCHEDULE = '0 2 * * 0';
export const PITR_DIFF_SCHEDULE = '0 2 * * 1-6';
/** WAL is archived at least once a minute, bounding RPO when traffic is low. */
export const PITR_ARCHIVE_TIMEOUT_SECONDS = 60;
/** Full backups are kept ~4 weeks; differentials cover the rest of the window. */
export const PITR_RETENTION_FULL = 4;
export const PITR_RETENTION_DIFF = 7;
/**
 * How often the control plane queues a `status` task per PITR database. The task also rewrites
 * the node's pgBackRest config, which lives on a tmpfs and is gone after a reboot.
 */
export const PITR_STATUS_INTERVAL_MS = 15 * 60_000;

/** The recoverable window and repository state a node's `status` task reports. */
export const databasePitrWindowSchema = z.object({
	/** Earliest restorable instant (epoch ms): the oldest retained backup's stop time. */
	recoverableFrom: z.number().int().nullable(),
	/** Latest restorable instant (epoch ms): the last archived WAL segment. */
	recoverableTo: z.number().int().nullable(),
	backupCount: z.number().int().min(0),
	newestBackupAt: z.number().int().nullable(),
	newestBackupType: z.enum(pitrBaseBackupTypes).nullable(),
	lastArchivedAt: z.number().int().nullable(),
	/** pgBackRest's stanza message when it reports a repository problem. */
	repoMessage: z.string().max(500).nullable(),
});
export type DatabasePitrWindow = z.infer<typeof databasePitrWindowSchema>;

/** A credential-free repository description, safe for views and audit args. */
export const databasePitrRepoViewSchema = z.object({
	kind: z.literal('s3'),
	/** null means AWS S3 for the configured region. */
	endpoint: z.url().nullable(),
	bucket: z.string().min(1).max(255),
	region: z.string().min(1).max(63),
	pathPrefix: z.string().max(300),
	forcePathStyle: z.boolean(),
});
export type DatabasePitrRepoView = z.infer<typeof databasePitrRepoViewSchema>;

/** Repository configuration with credentials. Returned only by the node activation endpoint. */
export const databasePitrRepoConfigSchema = databasePitrRepoViewSchema.extend({
	accessKeyId: z.string().min(3).max(128),
	secretAccessKey: z.string().min(8).max(512),
});
export type DatabasePitrRepoConfig = z.infer<typeof databasePitrRepoConfigSchema>;

export const databasePitrStatusSchema = z.object({
	databaseId: z.string(),
	databaseName: z.string(),
	enabled: z.boolean(),
	stanza: z.string(),
	status: z.enum(['pending', 'ok', 'failed', 'paused']),
	repo: databasePitrRepoViewSchema,
	archiveStatus: z.enum(['ok', 'failing', 'unknown']).nullable(),
	archiveAt: z.string().nullable(),
	lastBaseBackupAt: z.string().nullable(),
	lastBaseBackupType: z.enum(pitrBaseBackupTypes).nullable(),
	nextFullAt: z.string().nullable(),
	nextDiffAt: z.string().nullable(),
	lastRestoreTargetAt: z.string().nullable(),
	lastRestoreDatabaseId: z.string().nullable(),
	verifiedAt: z.string().nullable(),
	error: z.string().nullable(),
	/**
	 * The window a restore can target, from the node's last status check (ISO). Null until the
	 * first base backup has finished and been reported.
	 */
	recoverableFrom: z.string().nullable(),
	recoverableTo: z.string().nullable(),
	windowCheckedAt: z.string().nullable(),
});
export type DatabasePitrStatus = z.infer<typeof databasePitrStatusSchema>;

/** One unit of PITR work handed to a database's node in desired state. */
export const databasePitrTaskSchema = z.object({
	/** `pitr_<id>` task row id. */
	id: z.string().min(1).max(120),
	action: z.enum(['basebackup', 'restore', 'status']),
	/** Source database: the one whose data/WAL the task operates on. */
	databaseId: z.string().min(1).max(100),
	databaseName: z.string().min(1).max(80),
	engine: z.enum(databaseEngines),
	stanza: z.string().min(1).max(64),
	baseBackupType: z.enum(pitrBaseBackupTypes).nullable().default(null),
	/** Restore only: the new database the helper restores into. */
	targetDatabaseId: z.string().min(1).max(100).nullable().default(null),
	/** Restore only: epoch ms replayed by `pgbackrest restore --type=time`. */
	targetTime: z.number().int().nullable().default(null),
});
export type DatabasePitrTask = z.infer<typeof databasePitrTaskSchema>;

/** Credentials and repository details fetched by the node just before it runs a task. */
export const databasePitrActivationSchema = z.object({
	taskId: z.string().min(1).max(120),
	databaseId: z.string().min(1).max(100),
	action: z.enum(['basebackup', 'restore', 'status']),
	stanza: z.string().min(1).max(64),
	repo: databasePitrRepoConfigSchema,
	archiveTimeoutSeconds: z.number().int().min(1).max(3600).default(PITR_ARCHIVE_TIMEOUT_SECONDS),
});
export type DatabasePitrActivation = z.infer<typeof databasePitrActivationSchema>;

export const databasePitrResultSchema = z.object({
	taskId: z.string().min(1).max(120),
	action: z.enum(['basebackup', 'restore', 'status']),
	databaseId: z.string().min(1).max(100),
	targetDatabaseId: z.string().min(1).max(100).nullable().default(null),
	status: z.enum(['ok', 'failed']),
	baseBackupType: z.enum(pitrBaseBackupTypes).nullable().optional(),
	/** Restore only: the timestamp the helper actually replayed. */
	targetTime: z.number().int().nullable().optional(),
	/** Restore only: the canary query passed after the new instance started. */
	verified: z.boolean().optional(),
	/** Archive health reported by the `status` verb. */
	archiveStatus: z.enum(['ok', 'failing', 'unknown']).optional(),
	/** `status` only: the recoverable window. Absent from older agents. */
	window: databasePitrWindowSchema.optional(),
	error: z.string().max(2000).optional(),
});
export type DatabasePitrResult = z.infer<typeof databasePitrResultSchema>;

/** Manual base backup request. */
export const databasePitrBackupSchema = z.object({
	type: z.enum(pitrBaseBackupTypes).default('full'),
});
export type DatabasePitrBackup = z.input<typeof databasePitrBackupSchema>;

/** Enable/disable the WAL-archive policy for one database. */
export const databasePitrPolicySchema = z.object({
	enabled: z.boolean(),
});
export type DatabasePitrPolicy = z.infer<typeof databasePitrPolicySchema>;

/**
 * Restore to a timestamp into a new database. The name/limits fields match a logical restore;
 * `targetTime` is mandatory and must be an ISO 8601 timestamp with an offset or `Z`. Attaching a
 * project is deliberately omitted: the restore must stay on the source node in this slice, and a
 * project would move placement to the app's node. Attach after verification.
 */
export const databasePitrRestoreSchema = databaseRestoreSchema
	.omit({ project: true, envPrefix: true })
	.extend({
		targetTime: z.iso.datetime({ offset: true }),
	});
export type DatabasePitrRestore = z.input<typeof databasePitrRestoreSchema>;

/**
 * Validate a restore timestamp against the wall clock and the retention window. A future time or
 * one older than the repository retention cannot be replayed; reject before creating a database.
 * When the node has reported a recoverable window, `validatePitrTargetInWindow` is the stricter
 * check.
 */
export function validatePitrTargetTime(
	targetTime: number,
	now: number,
	retentionDays: number,
): { ok: true } | { ok: false; message: string } {
	if (!Number.isInteger(targetTime) || targetTime <= 0)
		return { ok: false, message: 'The restore target must be a positive epoch-millisecond timestamp.' };
	if (targetTime > now)
		return { ok: false, message: 'The restore target is in the future; choose a past timestamp.' };
	const oldest = now - retentionDays * 86_400_000;
	if (targetTime < oldest)
		return {
			ok: false,
			message: `The restore target is older than the ${retentionDays}-day repository retention window.`,
		};
	return { ok: true };
}

/** pgBackRest stanza names are derived from the database id and never come from the wire. */
export function pitrStanzaFor(databaseId: string): string {
	return databaseId.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Validate a restore timestamp against the recoverable window the node last reported. The window
 * opens at the oldest retained backup and closes at the last archived WAL; a target outside it
 * cannot be replayed (pgBackRest would pick no backup, or recovery would stop short).
 */
export function validatePitrTargetInWindow(
	targetTime: number,
	window: { recoverableFrom: number | null; recoverableTo: number | null },
): { ok: true } | { ok: false; message: string } {
	if (window.recoverableFrom === null || window.recoverableTo === null)
		return {
			ok: false,
			message: 'There is nothing to restore yet: no base backup has been reported for this database.',
		};
	if (targetTime < window.recoverableFrom)
		return {
			ok: false,
			message: `The restore target is before the earliest recoverable point (${new Date(window.recoverableFrom).toISOString()}).`,
		};
	if (targetTime > window.recoverableTo)
		return {
			ok: false,
			message: `The restore target is after the latest archived WAL (${new Date(window.recoverableTo).toISOString()}); pick an earlier time or wait for the archive to catch up.`,
		};
	return { ok: true };
}

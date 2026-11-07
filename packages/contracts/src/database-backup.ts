import * as z from 'zod';
import { databaseEngines, databaseNameSchema, type DatabaseEngine } from './database.ts';

/**
 * Managed database backups (docs/DATABASES.md §8). A backup is the engine's native dump (for
 * Postgres a `pg_dump -Fc` artifact) written to the org's backup target. Dumps execute on the database's node (the control plane never
 * reaches node loopback); the agent streams the dump straight to a presigned URL and reports the
 * result on its next heartbeat.
 */

/** The Postgres format, kept as a name for existing callers. */
export const DATABASE_BACKUP_FORMAT = 'pg_dump-custom' as const;

/**
 * Logical backup formats, one per engine family (docs/DATABASES.md §17). A backup is restored only
 * into a database of the same engine, so the format follows from the engine and is not stored.
 */
export const databaseBackupFormats = [
	'pg_dump-custom',
	'mysqldump-sql',
	'mariadb-dump-sql',
	'mongodump-archive-gzip',
	'valkey-rdb',
	'redis-rdb',
	'clickhouse-backup-zip',
] as const;
export type DatabaseBackupFormat = (typeof databaseBackupFormats)[number];

/**
 * The dump format an engine's backups use; null when the engine has no backups. Valkey/Redis use
 * the server's own RDB snapshot (`--rdb`), restored as the AOF base of the new instance; ClickHouse
 * uses its native `BACKUP DATABASE … TO File('….zip')` archive.
 */
export function databaseBackupFormat(engine: DatabaseEngine): DatabaseBackupFormat | null {
	switch (engine) {
		case 'postgres':
			return 'pg_dump-custom';
		case 'mysql':
			return 'mysqldump-sql';
		case 'mariadb':
			return 'mariadb-dump-sql';
		case 'mongodb':
			return 'mongodump-archive-gzip';
		case 'valkey':
			return 'valkey-rdb';
		case 'redis':
			return 'redis-rdb';
		case 'clickhouse':
			return 'clickhouse-backup-zip';
	}
}

/** Five-field cron expression: `*`, slash steps (`*` + `/n`), ranges and comma lists. */
export const cronSchema = z
	.string()
	.trim()
	.min(9)
	.max(100)
	.refine((value) => value.split(/\s+/).length === 5, 'Use a five-field cron expression (minute hour day month weekday).')
	.refine((value) => /^[\d*,\-/ ]+$/.test(value), 'Cron fields may only contain digits, *, ,, - and /.');

export const databaseBackupPolicySchema = z
	.object({
		enabled: z.boolean().default(true),
		/** Default: every day at 03:00 UTC. */
		schedule: cronSchema.default('0 3 * * *'),
		/** Backups older than this are deleted; the newest backup is never pruned. */
		retentionDays: z.number().int().min(1).max(365).default(7),
	})
	.partial()
	.refine((input) => Object.keys(input).length > 0, 'Nothing to update.');
export type DatabaseBackupPolicy = z.infer<typeof databaseBackupPolicySchema>;

export const databaseBackupCreateSchema = z.object({
	/** A pinned backup is never removed by retention. */
	pinned: z.boolean().default(false),
});
export type DatabaseBackupCreate = z.input<typeof databaseBackupCreateSchema>;

export const databaseRestoreSchema = z.object({
	name: databaseNameSchema,
	placement: z.string().min(1).max(64).default('auto'),
	memoryMb: z.number().int().min(128).max(16_384).optional(),
	cpus: z.number().positive().max(8).optional(),
	storageMb: z.number().int().min(256).max(1_048_576).optional(),
	volume: z.string().min(3).max(40).optional(),
	/** Attach the restored database to this project immediately. */
	project: z.string().min(1).max(64).optional(),
	envPrefix: z.string().min(1).max(64).optional(),
});
export type DatabaseRestore = z.input<typeof databaseRestoreSchema>;

export const databaseBackupStatuses = ['pending', 'running', 'ok', 'failed'] as const;
export type DatabaseBackupStatus = (typeof databaseBackupStatuses)[number];

export interface DatabaseBackupView {
	id: string;
	databaseId: string;
	databaseName: string;
	kind: 'manual' | 'scheduled';
	status: DatabaseBackupStatus;
	format: DatabaseBackupFormat;
	sizeBytes: number | null;
	sha256: string | null;
	objectKey: string;
	pinned: boolean;
	error: string | null;
	/** When a restore of this artifact completed successfully. */
	verifiedAt: string | null;
	/** Database created by the most recent successful restore, if it still exists. */
	restoredDatabaseId: string | null;
	startedAt: string;
	finishedAt: string | null;
	expiresAt: string | null;
	/** Where the artifact was written. Restore and retention always use this, never the current target. */
	target: DatabaseBackupLocation;
}

/** The backup target and exact object location recorded when a backup was taken. */
export interface DatabaseBackupLocation {
	/** Backup target id; null for the platform object store (no target was configured). */
	id: string | null;
	/** Target name when the backup was taken. */
	name: string;
	kind: 'platform' | 'local' | 's3';
	/** Exact object location, e.g. `s3://bucket/prefix/key (https://endpoint)` or `file:///dir/key`. */
	location: string;
	/** False when the recorded target was deleted: Skiff can no longer reach the object. */
	available: boolean;
	unavailableReason: string | null;
}

export interface DatabaseBackupSummary {
	enabled: boolean;
	schedule: string;
	retentionDays: number;
	nextBackupAt: string | null;
	lastBackupAt: string | null;
	lastBackupStatus: DatabaseBackupStatus | null;
	lastBackupError: string | null;
	lastVerifiedAt: string | null;
	pendingRestoreId: string | null;
}

/** One unit of work handed to the node in desired state. */
export const databaseBackupTaskSchema = z.object({
	/** Unique task id: the backup row id (backup) or `restore:<databaseId>` (restore). */
	id: z.string().min(1).max(120),
	action: z.enum(['backup', 'restore']),
	/** Target database: the one being dumped, or the new one being restored into. */
	databaseId: z.string().min(1).max(100),
	databaseName: z.string().min(1).max(80),
	engine: z.enum(databaseEngines),
	backupId: z.string().min(1).max(100).nullable().default(null),
	objectKey: z.string().min(1).max(512),
	/** Presigned PUT (backup) or GET (restore). */
	url: z.string().url(),
	format: z.enum(databaseBackupFormats),
});
export type DatabaseBackupTask = z.infer<typeof databaseBackupTaskSchema>;

export const databaseBackupResultSchema = z.object({
	taskId: z.string().min(1).max(120),
	action: z.enum(['backup', 'restore']),
	databaseId: z.string().min(1).max(100),
	backupId: z.string().min(1).max(100).nullable().default(null),
	status: z.enum(['ok', 'failed']),
	sizeBytes: z.number().int().nonnegative().optional(),
	sha256: z
		.string()
		.regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 lowercase hex characters')
		.optional(),
	error: z.string().max(2000).optional(),
});
export type DatabaseBackupResult = z.infer<typeof databaseBackupResultSchema>;

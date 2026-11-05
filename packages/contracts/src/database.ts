import * as z from 'zod';
import { SLUG_PATTERN } from './slugs.ts';
import type { DatabaseBackupSummary } from './database-backup.ts';
import type { VolumeSummary } from './volume.ts';

/**
 * Managed databases (docs/DATABASES.md, D55–D61).
 *
 * A database is an org resource run as a tier-3 container on one node. This module is the engine
 * registry and the wire shapes shared by the control plane, agent and surfaces. It deliberately
 * imports nothing from `workload.ts` so `workload.ts` can reference the engine enum.
 */

export const databaseEngines = ['postgres'] as const;
export type DatabaseEngine = (typeof databaseEngines)[number];

export interface DatabaseEngineInfo {
	engine: DatabaseEngine;
	label: string;
	versions: readonly string[];
	defaultVersion: string;
	/** Port inside the container. */
	containerPort: number;
	/** URL scheme for `<PREFIX>_URL`. */
	scheme: string;
	minMemoryMb: number;
	defaultMemoryMb: number;
}

/** The registry (D61). The helper keeps its own copy of the image/user mapping on purpose. */
export const databaseEngineRegistry: Record<DatabaseEngine, DatabaseEngineInfo> = {
	postgres: {
		engine: 'postgres',
		label: 'PostgreSQL',
		versions: ['17', '16'],
		defaultVersion: '17',
		containerPort: 5432,
		scheme: 'postgres',
		minMemoryMb: 128,
		defaultMemoryMb: 256,
	},
};

/**
 * Extensions Skiff can enable on a managed Postgres database. The helper preloads
 * `pg_stat_statements`; the rest are created idempotently by the agent after the monitor role is
 * bootstrapped. Extensions that are not shipped by the pinned official image fail softly (they
 * are reported in the log, not treated as a database failure).
 */
export const databaseExtensionAllowlist = [
	'pg_stat_statements',
	'pg_trgm',
	'pgcrypto',
	'citext',
	'hstore',
	'unaccent',
	'pg_cron',
	'pgvector',
	'postgis',
] as const;
export type DatabaseExtension = (typeof databaseExtensionAllowlist)[number];
export const databaseExtensionSchema = z.enum(databaseExtensionAllowlist);

/** Host ports allocated per node for database containers (loopback only, D56). */
export const DATABASE_PORT_MIN = 15432;
export const DATABASE_PORT_MAX = 16431;

/** Host ports for per-database PgBouncer sidecars (loopback only). */
export const DATABASE_POOLER_PORT_MIN = 16432;
export const DATABASE_POOLER_PORT_MAX = 17431;

export const databaseStatuses = ['pending', 'starting', 'running', 'failed', 'stopped'] as const;
export type DatabaseStatus = (typeof databaseStatuses)[number];

export const databaseNameSchema = z
	.string()
	.min(3)
	.max(40)
	.regex(SLUG_PATTERN, 'Use lowercase letters, digits and single hyphens; start and end with a letter or digit.')
	.refine((name) => !name.includes('--'), 'Double hyphens are not allowed.');

/** Prefix for injected env vars: `DATABASE` → `DATABASE_URL`, `DATABASE_HOST`, … */
export const databaseEnvPrefixSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Z][A-Z0-9_]*$/, 'Env prefixes must be UPPER_SNAKE_CASE')
	.refine((prefix) => !prefix.endsWith('_'), 'Env prefixes must not end with "_"');

export const databaseCreateSchema = z
	.object({
		name: databaseNameSchema,
		engine: z.enum(databaseEngines).default('postgres'),
		version: z.string().max(16).optional(),
		/** `auto`, `edge`, or a node id. Resolved once at create time (D41). */
		placement: z.string().min(1).max(64).default('auto'),
		memoryMb: z.number().int().min(128).max(16_384).optional(),
		cpus: z.number().positive().max(8).default(1),
		/** Storage budget used for alerts and the dashboard gauge, in MB. */
		storageMb: z.number().int().min(256).max(1_048_576).default(10_240),
		/** Node volume for the data dir; null keeps the helper state dir (D74). */
		volume: z.string().min(3).max(40).optional(),
		/** Attach to this project right away (placement then follows the project's workload node). */
		project: z.string().min(1).max(64).optional(),
		envPrefix: databaseEnvPrefixSchema.optional(),
		/** Extensions to create on first start (allowlist only). */
		extensions: z.array(databaseExtensionSchema).max(20).default([]),
		/** Run a transaction-mode PgBouncer sidecar and inject <PREFIX>_POOL_URL. */
		pooler: z.boolean().default(true),
	})
	.superRefine((input, ctx) => {
		const info = databaseEngineRegistry[input.engine];
		if (input.version && !info.versions.includes(input.version))
			ctx.addIssue({
				code: 'custom',
				path: ['version'],
				message: `${info.label} versions: ${info.versions.join(', ')}.`,
			});
		if (input.memoryMb !== undefined && input.memoryMb < info.minMemoryMb)
			ctx.addIssue({
				code: 'custom',
				path: ['memoryMb'],
				message: `${info.label} needs at least ${info.minMemoryMb} MB.`,
			});
	});
export type DatabaseCreate = z.input<typeof databaseCreateSchema>;

export const databaseUpdateSchema = z
	.object({
		memoryMb: z.number().int().min(128).max(16_384).optional(),
		cpus: z.number().positive().max(8).optional(),
		storageMb: z.number().int().min(256).max(1_048_576).optional(),
		/** Adding installs on the next activation. Removing never drops an extension automatically. */
		extensions: z.array(databaseExtensionSchema).max(20).optional(),
		/** Enable or disable the PgBouncer sidecar. */
		pooler: z.boolean().optional(),
	})
	.refine((input) => Object.keys(input).length > 0, 'Nothing to update.');
export type DatabaseUpdate = z.infer<typeof databaseUpdateSchema>;

export const databaseAttachSchema = z.object({
	database: databaseNameSchema,
	envPrefix: databaseEnvPrefixSchema.default('DATABASE'),
});
export type DatabaseAttach = z.input<typeof databaseAttachSchema>;

export interface DatabaseAttachmentView {
	databaseId: string;
	databaseName: string;
	projectId: string;
	projectSlug: string;
	envPrefix: string;
	/** Env var names the project receives at activation. */
	envNames: string[];
	createdAt: string;
}

export const databaseRotationRoles = ['owner', 'monitor'] as const;
export type DatabaseRotationRole = (typeof databaseRotationRoles)[number];

export const databaseRestartTargets = ['database', 'pooler'] as const;
export type DatabaseRestartTarget = (typeof databaseRestartTargets)[number];

export const databaseRestartSchema = z.object({
	target: z.enum(databaseRestartTargets).default('database'),
});
export type DatabaseRestart = z.input<typeof databaseRestartSchema>;

export const databaseRotateSchema = z.object({
	role: z.enum(databaseRotationRoles).default('owner'),
});
export type DatabaseRotate = z.input<typeof databaseRotateSchema>;

export interface DatabaseRotationView {
	id: string;
	databaseId: string;
	role: DatabaseRotationRole;
	status: 'pending' | 'running' | 'ok' | 'failed';
	error: string | null;
	createdAt: string;
	finishedAt: string | null;
}

export const databaseRotationTaskSchema = z.object({
	id: z.string().min(1).max(100),
	databaseId: z.string().min(1).max(100),
	role: z.enum(databaseRotationRoles),
});
export type DatabaseRotationTask = z.infer<typeof databaseRotationTaskSchema>;

export const databaseRotationActivationSchema = z.object({
	id: z.string(),
	databaseId: z.string(),
	role: z.enum(databaseRotationRoles),
	password: z.string(),
});
export type DatabaseRotationActivation = z.infer<typeof databaseRotationActivationSchema>;

export const databaseRotationResultSchema = z.object({
	taskId: z.string().min(1).max(100),
	databaseId: z.string().min(1).max(100),
	role: z.enum(databaseRotationRoles),
	status: z.enum(['ok', 'failed']),
	error: z.string().max(2_000).optional(),
});
export type DatabaseRotationResult = z.infer<typeof databaseRotationResultSchema>;

export interface DatabaseSlowQuery {
	/** `pg_stat_statements.queryid` (stable for the same normalized query). */
	queryId: string;
	/** Normalized SQL; literals are placeholders, never values. */
	query: string;
	calls: number;
	totalMs: number;
	meanMs: number;
	rows: number;
	sharedBlocks: number;
	tempBlocks: number;
}

export interface DatabaseTableStat {
	schema: string;
	name: string;
	/** `n_live_tup`, an estimate. */
	rows: number;
	totalBytes: number;
	seqScans: number;
	idxScans: number;
	lastAutovacuum: string | null;
	lastAutoanalyze: string | null;
}

export interface DatabaseView {
	id: string;
	name: string;
	engine: DatabaseEngine;
	engineLabel: string;
	version: string;
	status: DatabaseStatus;
	message: string | null;
	nodeId: string;
	nodeName: string | null;
	memoryMb: number;
	cpus: number;
	storageMb: number;
	/** Latest sampled size, if the agent has reported one. */
	sizeBytes: number | null;
	/** Postgres database / role names (not secret). */
	databaseName: string;
	username: string;
	/** What an attached app on the same node connects to (no password). */
	internalHost: { process: string; container: string };
	/** Optional PgBouncer sidecar and the addresses an app uses for it. */
	pooler: { enabled: boolean; host: { process: string; container: string }; port: number | null };
	/** Where the data dir lives; null keeps the helper state dir (D74). */
	volume: VolumeSummary | null;
	attachments: DatabaseAttachmentView[];
	tables: DatabaseTableStat[];
	statsAt: string | null;
	/** Requested extensions (the node installs them best-effort on first start). */
	extensions: DatabaseExtension[];
	/** Latest top-50 slow-query snapshot from `pg_stat_statements`. */
	slowQueries: DatabaseSlowQuery[];
	slowQueriesAt: string | null;
	/** Backup policy and last known result (docs/DATABASES.md §9). */
	backup: DatabaseBackupSummary;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
	purgeAt: string | null;
}

export interface DatabaseCredentials {
	databaseId: string;
	name: string;
	username: string;
	password: string;
	databaseName: string;
	/** Same-node URL for a process app (loopback). */
	url: string;
	host: string;
	port: number;
	note: string;
}

/** The `database` profile on a workload sent to the helper (D61): engine + version only. */
export const workloadDatabaseSchema = z.object({
	engine: z.enum(databaseEngines),
	version: z.string().min(1).max(16),
	/**
	 * WAL archiving for PITR (docs/PITR.md). Present only while the `PITR` flag is on and the
	 * database has PITR enabled; the helper renders `archive_mode`/`archive_command` from it.
	 */
	pitr: z
		.object({
			stanza: z.string().min(1).max(64),
			archiveTimeoutSeconds: z.number().int().min(1).max(3600).default(60),
		})
		.optional(),
});
export type WorkloadDatabase = z.infer<typeof workloadDatabaseSchema>;

/** Extra activation data for the agent's stats sampler; stripped before the helper sees it. */
export const databaseMonitorSchema = z.object({
	databaseName: z.string(),
	ownerUser: z.string(),
	ownerPassword: z.string(),
	monitorUser: z.string(),
	monitorPassword: z.string(),
	port: z.number().int().positive(),
});
export type DatabaseMonitor = z.infer<typeof databaseMonitorSchema>;

/** One database's 1-minute sample (D57). Counters are per-minute deltas. */
export const databaseMetricBucketSchema = z.object({
	databaseId: z.string().max(100),
	bucket: z.string(),
	up: z.boolean(),
	sizeBytes: z.number().int().nonnegative().default(0),
	connectionsActive: z.number().int().nonnegative().default(0),
	connectionsIdle: z.number().int().nonnegative().default(0),
	connectionsTotal: z.number().int().nonnegative().default(0),
	maxConnections: z.number().int().nonnegative().default(0),
	memoryBytes: z.number().int().nonnegative().default(0),
	xactCommit: z.number().int().nonnegative().default(0),
	xactRollback: z.number().int().nonnegative().default(0),
	tupReturned: z.number().int().nonnegative().default(0),
	tupFetched: z.number().int().nonnegative().default(0),
	tupInserted: z.number().int().nonnegative().default(0),
	tupUpdated: z.number().int().nonnegative().default(0),
	tupDeleted: z.number().int().nonnegative().default(0),
	blksHit: z.number().int().nonnegative().default(0),
	blksRead: z.number().int().nonnegative().default(0),
	deadlocks: z.number().int().nonnegative().default(0),
	tempBytes: z.number().int().nonnegative().default(0),
});
export type DatabaseMetricBucket = z.infer<typeof databaseMetricBucketSchema>;

export const databaseTableStatSchema = z.object({
	schema: z.string().max(128),
	name: z.string().max(128),
	rows: z.number().nonnegative(),
	totalBytes: z.number().nonnegative(),
	seqScans: z.number().nonnegative(),
	idxScans: z.number().nonnegative(),
	lastAutovacuum: z.string().max(40).nullable(),
	lastAutoanalyze: z.string().max(40).nullable(),
});

export const databaseSlowQuerySchema = z.object({
	queryId: z.string().max(40),
	query: z.string().max(2_000),
	calls: z.number().nonnegative(),
	totalMs: z.number().nonnegative(),
	meanMs: z.number().nonnegative(),
	rows: z.number().nonnegative(),
	sharedBlocks: z.number().nonnegative(),
	tempBlocks: z.number().nonnegative(),
});

export const databaseSnapshotSchema = z.object({
	databaseId: z.string().max(100),
	at: z.string(),
	tables: z.array(databaseTableStatSchema).max(50),
	/** Top slow queries when `pg_stat_statements` is enabled; omitted otherwise. */
	slowQueries: z.array(databaseSlowQuerySchema).max(50).optional(),
});
export type DatabaseSnapshot = z.infer<typeof databaseSnapshotSchema>;

/** Point returned by `GET /databases/:name/metrics`. Rates are per minute or per hour bucket. */
export interface DatabaseMetricPoint {
	bucket: string;
	up: number;
	sizeBytes: number;
	connectionsActive: number;
	connectionsIdle: number;
	connectionsTotal: number;
	maxConnections: number;
	memoryBytes: number;
	xactCommit: number;
	xactRollback: number;
	tupReturned: number;
	tupFetched: number;
	tupInserted: number;
	tupUpdated: number;
	tupDeleted: number;
	blksHit: number;
	blksRead: number;
	deadlocks: number;
	tempBytes: number;
}

/** `db-<hex>`: the container's DNS alias on the `skiff-workloads` network. */
export function databaseAlias(id: string): string {
	return `db-${id.replace(/^db_/, '').toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
}

/** Postgres identifier for a database name: `my-app` → `my_app`. */
export function databaseIdentifier(name: string): string {
	return name.replace(/-/g, '_');
}

/** Env var names a project receives for one attachment. */
export function databaseEnvNames(prefix: string): string[] {
	return ['URL', 'HOST', 'PORT', 'USER', 'PASSWORD', 'NAME'].map((suffix) => `${prefix}_${suffix}`);
}

/** OCI image for an engine version. The helper has its own copy and rejects any mismatch (D61). */
export function databaseImage(engine: DatabaseEngine, version: string): string {
	switch (engine) {
		case 'postgres':
			return `docker.io/library/postgres:${version}-alpine`;
	}
}

/** Role the agent's stats sampler uses (`pg_monitor` only, D57). */
export const DATABASE_MONITOR_USER = 'skiff_monitor';

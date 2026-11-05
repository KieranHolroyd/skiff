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
/** PgBouncer's `max_client_conn`; the helper renders the same value (D85). */
export const DATABASE_POOLER_MAX_CLIENTS = 200;

/** TLS modes a managed database connection can use. `require` encrypts; `verify-full` pins the CA. */
export const databaseSslModes = ['disable', 'require', 'verify-full'] as const;
export type DatabaseSslMode = (typeof databaseSslModes)[number];

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

/**
 * Named database credentials (plan 04b). `owner` and `monitor` are created with the database;
 * `app`, `readonly` and `backup` are opt-in and provisioned as separate Postgres roles.
 */
export const databaseCredentialRoles = ['owner', 'app', 'monitor', 'readonly', 'backup'] as const;
export type DatabaseCredentialRole = (typeof databaseCredentialRoles)[number];

/** The roles a human can add after create. Owner/monitor are managed by the database itself. */
export const databaseNamedCredentialRoles = ['app', 'readonly', 'backup'] as const;
export type DatabaseNamedCredentialRole = (typeof databaseNamedCredentialRoles)[number];

export const databaseCredentialStatuses = ['pending', 'ready', 'failed', 'revoking', 'revoked'] as const;
export type DatabaseCredentialStatus = (typeof databaseCredentialStatuses)[number];

export const databaseCredentialCreateSchema = z.object({
	role: z.enum(databaseNamedCredentialRoles).default('app'),
	purpose: z.string().min(1).max(120).optional(),
	expiresAt: z.string().datetime().optional(),
});
export type DatabaseCredentialCreate = z.input<typeof databaseCredentialCreateSchema>;

export interface DatabaseCredentialView {
	id: string;
	databaseId: string;
	role: DatabaseCredentialRole;
	username: string;
	purpose: string | null;
	status: DatabaseCredentialStatus;
	lastUsedAt: string | null;
	expiresAt: string | null;
	createdAt: string;
	revokedAt: string | null;
}

/** A credential plus its secret. Only an interactive reveal returns this shape. */
export interface DatabaseCredentialReveal extends DatabaseCredentialView {
	password: string;
}

export const databaseCredentialTaskSchema = z.object({
	id: z.string().min(1).max(100),
	databaseId: z.string().min(1).max(100),
	action: z.enum(['grant', 'revoke']),
	role: z.enum(databaseCredentialRoles),
	username: z.string().min(1).max(63),
});
export type DatabaseCredentialTask = z.infer<typeof databaseCredentialTaskSchema>;

export const databaseCredentialActivationSchema = z.object({
	id: z.string(),
	databaseId: z.string(),
	action: z.enum(['grant', 'revoke']),
	role: z.enum(databaseCredentialRoles),
	username: z.string(),
	password: z.string().optional(),
});
export type DatabaseCredentialActivation = z.infer<typeof databaseCredentialActivationSchema>;

export const databaseCredentialResultSchema = z.object({
	taskId: z.string().min(1).max(100),
	databaseId: z.string().min(1).max(100),
	status: z.enum(['ok', 'failed']),
	error: z.string().max(2_000).optional(),
});
export type DatabaseCredentialResult = z.infer<typeof databaseCredentialResultSchema>;

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
	pooler: {
		enabled: boolean;
		host: { process: string; container: string };
		port: number | null;
		/** Transaction pooling; session-only features need the direct URL. */
		mode: 'transaction';
		/** Template for the pooled URL (`{user}`, `{password}`, `{host}`, `{port}`, `{database}`). */
		urlTemplate: string | null;
	};
	/** TLS state derived from the node's certificate files (no private key leaves the node). */
	tls: {
		enabled: boolean;
		mode: DatabaseSslMode;
		caPem: string | null;
		/** Last certificate-generation / startup warning from the node, if any. */
		error: string | null;
	};
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
	/** Same-node direct URL for a process app (loopback). */
	url: string;
	/** Direct URL; use this for migrations and session-only features. */
	directUrl: string;
	/** Pooled URL when the pooler is enabled; null otherwise. */
	poolerUrl: string | null;
	host: string;
	port: number;
	sslmode: DatabaseSslMode;
	tlsEnabled: boolean;
	/** PEM of the per-database CA; public material, never a private key. */
	caPem: string | null;
	/** Copy-paste snippets keyed by client (`psql`, `prisma`, `drizzle`, …). */
	connectionSnippets: Record<string, string>;
	note: string;
}

/** The `database` profile on a workload sent to the helper (D61): engine + version only. */
export const workloadDatabaseSchema = z.object({
	engine: z.enum(databaseEngines),
	version: z.string().min(1).max(16),
	/** Render Postgres with a helper-generated server certificate (SKIFF_FEATURE_DB_TLS). */
	tls: z.boolean().optional(),
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
	/** PgBouncer `SHOW POOLS`/`SHOW STATS` gauges; zero when the pooler is disabled or down. */
	poolerUp: z.number().int().min(0).max(1).default(0),
	poolActive: z.number().int().nonnegative().default(0),
	poolIdle: z.number().int().nonnegative().default(0),
	poolWaiting: z.number().int().nonnegative().default(0),
	poolSaturation: z.number().min(0).max(1).default(0),
	poolAvgWaitMs: z.number().nonnegative().default(0),
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
	poolerUp: number;
	poolActive: number;
	poolIdle: number;
	poolWaiting: number;
	poolSaturation: number;
	poolAvgWaitMs: number;
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

/** `db-<hex>`: the container's DNS alias on the workload's org network (or the legacy shared network). */
export function databaseAlias(id: string): string {
	return `db-${id.replace(/^db_/, '').toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
}

/** Postgres identifier for a database name: `my-app` → `my_app`. */
export function databaseIdentifier(name: string): string {
	return name.replace(/-/g, '_');
}

/** Env var names a project receives for one attachment. */
export function databaseEnvNames(
	prefix: string,
	options: { pooler?: boolean; tls?: boolean } = {},
): string[] {
	const names = ['URL', 'HOST', 'PORT', 'USER', 'PASSWORD', 'NAME'];
	if (options.tls) names.push('SSL_MODE', 'CA_CERT');
	if (options.pooler) names.push('POOL_URL', 'POOL_HOST', 'POOL_PORT');
	return names.map((suffix) => `${prefix}_${suffix}`);
}

export interface DatabaseUrlOptions {
	scheme: string;
	user: string;
	pass: string;
	host: string;
	port: number;
	database: string;
	sslmode?: DatabaseSslMode;
}

/** A connection string; `sslmode` is appended only when TLS is in use. */
export function databaseConnectionUrl(options: DatabaseUrlOptions): string {
	const user = encodeURIComponent(options.user);
	const pass = encodeURIComponent(options.pass);
	const database = encodeURIComponent(options.database);
	const base = `${options.scheme}://${user}:${pass}@${options.host}:${options.port}/${database}`;
	return options.sslmode && options.sslmode !== 'disable' ? `${base}?sslmode=${options.sslmode}` : base;
}

export interface DatabaseSnippetInput {
	/** Direct URL. */
	directUrl: string;
	/** Pooled URL when enabled. */
	poolerUrl: string | null;
	sslmode: DatabaseSslMode;
	caPem: string | null;
	/** Env prefix the attached app receives (default `DATABASE`). */
	envPrefix?: string;
}

/**
 * Copy-paste connection snippets for the credentials response (docs/DATABASES.md §10). The
 * default `url` is pooled when available; `direct` is explicit because migrations, logical
 * replication, `LISTEN`, advisory locks and session state need a direct connection.
 */
export function databaseConnectionSnippets(input: DatabaseSnippetInput): Record<string, string> {
	const prefix = input.envPrefix ?? 'DATABASE';
	const url = input.poolerUrl ?? input.directUrl;
	const direct = input.directUrl;
	const ca = input.caPem ? `\n-- ${prefix}_CA_CERT holds the PEM CA certificate.` : '';
	const pooledEnv = input.poolerUrl ? `${prefix}_POOL_URL` : `${prefix}_URL`;
	const caEnv = input.caPem ? `\n${prefix}_CA_CERT="$(cat ca.pem)"` : '';
	const ssl = input.sslmode === 'disable' ? '' : '?sslmode=require';
	return {
		psql: `psql "${url}"`,
		direct: `psql "${direct}"  # migrations, pg_dump, LISTEN/NOTIFY, advisory locks, session state`,
		prisma: `# schema.prisma (run migrations against directUrl)\ndatasource db {\n  provider  = "postgresql"\n  url       = env("${pooledEnv}")\n  directUrl = env("${prefix}_URL")\n}${ca}`,
		drizzle: `import { drizzle } from 'drizzle-orm/postgres-js';\nimport postgres from 'postgres';\n\nconst sql = postgres(process.env.${prefix}_URL!, { ssl: 'require' });\nexport const db = drizzle(sql);${ca}`,
		kysely: `import { Kysely, PostgresDialect } from 'kysely';\nimport { Pool } from 'pg';\n\nexport const db = new Kysely({\n  dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.${prefix}_URL }) }),\n});${ca}`,
		django: `# settings.py\nimport os, dj_database_url\nDATABASES = {'default': dj_database_url.parse(os.environ['${prefix}_URL'])}${ca}`,
		rails: `# config/database.yml\nproduction:\n  url: <%= ENV.fetch('${prefix}_URL') %>${ca}`,
		pgx: `pool, err := pgxpool.New(ctx, os.Getenv("${prefix}_URL"))\nif err != nil { log.Fatal(err) }${ca}`,
		nodePostgres: `import fs from 'node:fs';\nimport { Pool } from 'pg';\n\nconst pool = new Pool({\n  connectionString: process.env.${prefix}_URL,\n${input.caPem ? `  ssl: { ca: fs.readFileSync(process.env.${prefix}_CA_CERT || 'ca.pem') },\n` : ''}});${ca}`,
		verifyFull: input.caPem
			? `# Verify the server certificate against the per-database CA (host must be in the SAN):\npsql "${direct.replace(ssl, '?sslmode=verify-full')}"  # also set sslrootcert=ca.pem${caEnv}`
			: '# TLS is disabled; enable SKIFF_FEATURE_DB_TLS to encrypt connections.',
	};
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

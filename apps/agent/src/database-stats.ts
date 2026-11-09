import { SQL } from 'bun';
import {
	DATABASE_POOLER_MAX_CLIENTS,
	databaseExtensionCatalog,
	databaseMetricBucketSchema,
	databaseSnapshotSchema,
	type DatabaseMetricBucket,
	type DatabaseMonitor,
	type DatabaseSlowQuery,
	type DatabaseSnapshot,
	type DatabaseTableStat,
	type WorkloadStatus,
} from '@yoal/contracts';

/**
 * Managed database sampler (D57). Once a minute it connects to every database on this node over
 * loopback, as the `yoal_monitor` role (`pg_monitor` only), and buffers one bucket per database
 * for the telemetry batch. Every fifth sample it also takes the top-50 table snapshot.
 *
 * Credentials live in memory only. The owner password from the activation payload is used once
 * per (database, activation version) to create or update the monitor role, and is then dropped.
 */

export const DATABASE_STATS_INTERVAL_MS = 60_000;
const SNAPSHOT_EVERY = 5;
const MAX_BUCKETS = 5_000;
const MAX_SNAPSHOTS = 200;
const TABLE_LIMIT = 50;

/** The `CREATE EXTENSION` name for an allowlisted extension, or null for anything else. */
export function extensionSqlName(extension: string): string | null {
	return Object.hasOwn(databaseExtensionCatalog, extension)
		? databaseExtensionCatalog[extension as keyof typeof databaseExtensionCatalog].sqlName
		: null;
}

/** What the sampler needs to know about one database; provided by the workload runtime. */
export interface DatabaseTarget {
	id: string;
	activationVersion: string;
	/** Loopback host port. */
	port: number;
	status: WorkloadStatus;
	/** Container memory from the helper's status report. */
	memoryBytes?: number;
	/** `ownerPassword` is null once the monitor role is known to exist. */
	monitor: Omit<DatabaseMonitor, 'ownerPassword'> & { ownerPassword: string | null };
	/** Allowlisted extensions to create after the monitor role is bootstrapped. */
	extensions?: string[];
	/** Present when TLS is active; the CA is public material from the helper. */
	tls?: { caPem: string | null };
	/** Present when the PgBouncer sidecar is enabled; the admin credential is memory-only. */
	pooler?: { port: number; username: string; password: string };
}

export interface DatabasePoolMetrics {
	poolerUp: number;
	poolActive: number;
	poolIdle: number;
	poolWaiting: number;
	poolSaturation: number;
	poolAvgWaitMs: number;
}

export interface DatabaseTargetSource {
	databaseTargets(): DatabaseTarget[];
	forgetOwnerPassword(id: string, activationVersion: string): void;
}

/** The slice of a SQL client the sampler uses; Bun's `SQL` in production, a fake in tests. */
export interface SqlClient {
	query(text: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
	close(): Promise<void>;
}

export interface SqlConnectOptions {
	hostname: string;
	port: number;
	username: string;
	password: string;
	database: string;
	/** `false` keeps a loopback/admin connection plaintext; the sampler uses the CA when present. */
	tls?: { ca?: string; rejectUnauthorized?: boolean } | false;
}

export type SqlConnector = (options: SqlConnectOptions) => SqlClient;

/** Bun's built-in Postgres client: one short-lived connection per sample. */
export function bunSqlConnector(): SqlConnector {
	return (options) => {
		const sql = new SQL({
			adapter: 'postgres',
			hostname: options.hostname,
			port: options.port,
			username: options.username,
			password: options.password,
			database: options.database,
			max: 1,
			connectionTimeout: 5,
			idleTimeout: 5,
			maxLifetime: 60,
			tls: options.tls ?? false,
		});
		return {
			async query(text, params = []) {
				const rows = (await sql.unsafe(text, params)) as unknown as Array<Record<string, unknown>>;
				return [...rows];
			},
			async close() {
				await sql.close({ timeout: 1 });
			},
		};
	};
}

export interface DatabaseTelemetryPayload {
	databases: DatabaseMetricBucket[];
	databaseSnapshots: DatabaseSnapshot[];
}

export type DatabaseStatsLog = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface DatabaseStatsSamplerOptions {
	source: DatabaseTargetSource;
	connect?: SqlConnector;
	now?: () => number;
	log?: DatabaseStatsLog;
	snapshotEvery?: number;
	maxBuckets?: number;
	maxSnapshots?: number;
}

const COUNTERS = [
	'xactCommit',
	'xactRollback',
	'tupReturned',
	'tupFetched',
	'tupInserted',
	'tupUpdated',
	'tupDeleted',
	'blksHit',
	'blksRead',
	'deadlocks',
	'tempBytes',
] as const;
type CounterName = (typeof COUNTERS)[number];
type Counters = Record<CounterName, number>;

/** Keeps the sampler cheap even on a database with a huge catalog. */
export const STATEMENT_TIMEOUT_SQL = "SET statement_timeout = '10s'";

/**
 * Idempotent monitor-role bootstrap, run as the owner. Identifiers and the password are quoted by
 * Postgres itself (`format` with `%I`/`%L`); the statements it returns are then executed as-is.
 */
export const BOOTSTRAP_SQL = `SELECT
	CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1::text)
		THEN format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 5 PASSWORD %L', $1::text, $2::text)
		ELSE format('CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 5 PASSWORD %L', $1::text, $2::text)
	END AS role_sql,
	format('GRANT pg_monitor TO %I', $1::text) AS monitor_sql,
	format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text) AS connect_sql`;

/** Gauges and raw counters for the current database, as `yoal_monitor`. */
export const STATS_SQL = `SELECT
	pg_database_size(current_database())::float8 AS size_bytes,
	(SELECT count(*) FROM pg_stat_activity a
		WHERE a.datname = current_database() AND a.backend_type = 'client backend'
			AND a.pid <> pg_backend_pid() AND a.state = 'active')::int AS connections_active,
	(SELECT count(*) FROM pg_stat_activity a
		WHERE a.datname = current_database() AND a.backend_type = 'client backend'
			AND a.pid <> pg_backend_pid() AND a.state LIKE 'idle%')::int AS connections_idle,
	(SELECT count(*) FROM pg_stat_activity a
		WHERE a.datname = current_database() AND a.backend_type = 'client backend'
			AND a.pid <> pg_backend_pid())::int AS connections_total,
	current_setting('max_connections')::int AS max_connections,
	d.xact_commit::float8 AS xact_commit,
	d.xact_rollback::float8 AS xact_rollback,
	d.tup_returned::float8 AS tup_returned,
	d.tup_fetched::float8 AS tup_fetched,
	d.tup_inserted::float8 AS tup_inserted,
	d.tup_updated::float8 AS tup_updated,
	d.tup_deleted::float8 AS tup_deleted,
	d.blks_hit::float8 AS blks_hit,
	d.blks_read::float8 AS blks_read,
	d.deadlocks::float8 AS deadlocks,
	d.temp_bytes::float8 AS temp_bytes
FROM pg_stat_database d
WHERE d.datname = current_database()`;

/** Top tables by total size (heap + indexes + TOAST). */
/** Top statements by total execution time, when `pg_stat_statements` is installed. */
export const SLOW_QUERIES_SQL = `SELECT
	queryid::text AS query_id,
	query,
	calls::float8 AS calls,
	total_exec_time::float8 AS total_ms,
	mean_exec_time::float8 AS mean_ms,
	rows::float8 AS rows,
	shared_blks_hit::float8 + shared_blks_read::float8 AS shared_blocks,
	temp_blks_read::float8 + temp_blks_written::float8 AS temp_blocks
FROM pg_stat_statements
WHERE query NOT LIKE '%pg_stat_statements%'
ORDER BY total_exec_time DESC
LIMIT 50`;

export const TABLES_SQL = `SELECT
	schemaname AS schema,
	relname AS name,
	n_live_tup::float8 AS rows,
	pg_total_relation_size(relid)::float8 AS total_bytes,
	seq_scan::float8 AS seq_scans,
	COALESCE(idx_scan, 0)::float8 AS idx_scans,
	last_autovacuum,
	last_autoanalyze
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC, schemaname, relname
LIMIT ${TABLE_LIMIT}`;

/** PgBouncer admin console queries (the database must be `pgbouncer`). */
export const POOLER_POOLS_SQL = 'SHOW POOLS';
export const POOLER_STATS_SQL = 'SHOW STATS';

const EMPTY_POOL: DatabasePoolMetrics = {
	poolerUp: 0,
	poolActive: 0,
	poolIdle: 0,
	poolWaiting: 0,
	poolSaturation: 0,
	poolAvgWaitMs: 0,
};

/**
 * Aggregate `SHOW POOLS` rows. `cl_active`/`cl_waiting` are client connections; `sv_idle` is the
 * server pool's idle capacity. Saturation is measured against PgBouncer's `max_client_conn`, which
 * the helper renders as `DATABASE_POOLER_MAX_CLIENTS`.
 */
export function parsePoolerPools(
	rows: Array<Record<string, unknown>>,
	maxClients = DATABASE_POOLER_MAX_CLIENTS,
): DatabasePoolMetrics {
	let active = 0;
	let idle = 0;
	let waiting = 0;
	for (const row of rows) {
		// The `pgbouncer` admin pseudo-database is not a user pool.
		if (String(row.database ?? '') === 'pgbouncer') continue;
		active += int(row.cl_active);
		idle += int(row.sv_idle);
		waiting += int(row.cl_waiting);
	}
	const used = active + waiting;
	const saturation = maxClients > 0 ? Math.min(1, used / maxClients) : 0;
	return {
		poolerUp: 1,
		poolActive: active,
		poolIdle: idle,
		poolWaiting: waiting,
		poolSaturation: saturation,
		poolAvgWaitMs: 0,
	};
}

/** Add the average server wait from `SHOW STATS` (microseconds, weighted by transactions). */
export function parsePoolerStats(
	rows: Array<Record<string, unknown>>,
	base: DatabasePoolMetrics = EMPTY_POOL,
): DatabasePoolMetrics {
	let weighted = 0;
	let transactions = 0;
	for (const row of rows) {
		if (String(row.database ?? '') === 'pgbouncer') continue;
		const count = int(row.total_xact_count);
		weighted += int(row.avg_wait_time) * count;
		transactions += count;
	}
	const poolAvgWaitMs = transactions > 0 ? Math.max(0, weighted / transactions / 1_000) : 0;
	return { ...base, poolerUp: 1, poolAvgWaitMs };
}

const COUNTER_COLUMNS: Record<CounterName, string> = {
	xactCommit: 'xact_commit',
	xactRollback: 'xact_rollback',
	tupReturned: 'tup_returned',
	tupFetched: 'tup_fetched',
	tupInserted: 'tup_inserted',
	tupUpdated: 'tup_updated',
	tupDeleted: 'tup_deleted',
	blksHit: 'blks_hit',
	blksRead: 'blks_read',
	deadlocks: 'deadlocks',
	tempBytes: 'temp_bytes',
};

interface SampleState {
	activationVersion: string;
	bootstrapped: boolean;
	counters: Counters | null;
	/** Successful samples so far; the snapshot is taken on 0, 5, 10, … */
	samples: number;
}

export class DatabaseStatsSampler {
	private readonly source: DatabaseTargetSource;
	private readonly connect: SqlConnector;
	private readonly now: () => number;
	private readonly log: DatabaseStatsLog;
	private readonly snapshotEvery: number;
	private readonly maxBuckets: number;
	private readonly maxSnapshots: number;

	private readonly state = new Map<string, SampleState>();
	private buckets: DatabaseMetricBucket[] = [];
	private snapshots: DatabaseSnapshot[] = [];
	private sampling = false;
	private totalDropped = 0;

	constructor(options: DatabaseStatsSamplerOptions) {
		this.source = options.source;
		this.connect = options.connect ?? bunSqlConnector();
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => undefined);
		this.snapshotEvery = Math.max(1, options.snapshotEvery ?? SNAPSHOT_EVERY);
		this.maxBuckets = options.maxBuckets ?? MAX_BUCKETS;
		this.maxSnapshots = options.maxSnapshots ?? MAX_SNAPSHOTS;
	}

	/** Buckets and snapshots dropped to keep the buffer bounded. */
	get dropped(): number {
		return this.totalDropped;
	}

	/** What the next telemetry POST would carry. */
	pending(): DatabaseTelemetryPayload {
		return { databases: [...this.buckets], databaseSnapshots: [...this.snapshots] };
	}

	/** Sample every database once. Never throws; overlapping calls are skipped. */
	async sample(): Promise<number> {
		if (this.sampling) return 0;
		this.sampling = true;
		try {
			const targets = this.source.databaseTargets();
			const ids = new Set(targets.map((target) => target.id));
			for (const id of [...this.state.keys()]) if (!ids.has(id)) this.state.delete(id);
			const bucket = new Date(Math.floor(this.now() / 60_000) * 60_000).toISOString();
			const results = await Promise.all(targets.map((target) => this.sampleOne(target, bucket)));
			return results.filter(Boolean).length;
		} finally {
			this.sampling = false;
		}
	}

	/**
	 * POST the buffer through `post`. The buffer is cleared only after `post` resolves; a failure
	 * keeps everything for the next attempt and rethrows.
	 */
	async flush(post: (payload: DatabaseTelemetryPayload) => Promise<void>): Promise<boolean> {
		if (this.buckets.length === 0 && this.snapshots.length === 0) return false;
		const payload = this.pending();
		await post(payload);
		const sentBuckets = new Set(payload.databases);
		const sentSnapshots = new Set(payload.databaseSnapshots);
		this.buckets = this.buckets.filter((bucket) => !sentBuckets.has(bucket));
		this.snapshots = this.snapshots.filter((snapshot) => !sentSnapshots.has(snapshot));
		return true;
	}

	private stateFor(target: DatabaseTarget): SampleState {
		let state = this.state.get(target.id);
		if (!state || state.activationVersion !== target.activationVersion) {
			// A new activation may carry new credentials: bootstrap again. Counters survive, since
			// the cluster (and its stats) did not change.
			state = {
				activationVersion: target.activationVersion,
				bootstrapped: false,
				counters: state?.counters ?? null,
				samples: state?.samples ?? 0,
			};
			this.state.set(target.id, state);
		}
		return state;
	}

	private async sampleOne(target: DatabaseTarget, bucket: string): Promise<boolean> {
		const state = this.stateFor(target);
		if (target.status !== 'running') return this.pushBucket(downBucket(target, bucket));

		if (!state.bootstrapped) {
			if (target.monitor.ownerPassword !== null) {
				try {
					await this.bootstrap(target, target.monitor.ownerPassword);
					state.bootstrapped = true;
					this.source.forgetOwnerPassword(target.id, target.activationVersion);
					this.log('info', `Database ${target.id}: monitor role ready`);
				} catch (error) {
					// Usually the cluster is still initialising; try again next minute.
					const detail = scrub(errorText(error), [target.monitor.ownerPassword, target.monitor.monitorPassword]);
					this.log('warn', `Database ${target.id}: monitor bootstrap failed: ${detail}`);
					return this.pushBucket(downBucket(target, bucket));
				}
			}
			// Without an owner password the role was bootstrapped earlier; sample as the monitor.
		} else if (target.monitor.ownerPassword !== null) {
			// A re-fetched activation brought the owner password back; it is not needed.
			this.source.forgetOwnerPassword(target.id, target.activationVersion);
		}

		let client: SqlClient | null = null;
		try {
			client = this.connect({
				hostname: '127.0.0.1',
				port: target.port,
				username: target.monitor.monitorUser,
				password: target.monitor.monitorPassword,
				database: target.monitor.databaseName,
				...tlsOptions(target),
			});
			await client.query(STATEMENT_TIMEOUT_SQL);
			const [row] = await client.query(STATS_SQL);
			if (!row) throw new Error('pg_stat_database has no row for the current database');
			const counters = readCounters(row);
			const deltas = counterDeltas(state.counters, counters);
			state.counters = counters;
			const pool = await this.samplePooler(target);
			const pushed = this.pushBucket({
				databaseId: target.id,
				bucket,
				up: true,
				sizeBytes: int(row.size_bytes),
				connectionsActive: int(row.connections_active),
				connectionsIdle: int(row.connections_idle),
				connectionsTotal: int(row.connections_total),
				maxConnections: int(row.max_connections),
				memoryBytes: int(target.memoryBytes),
				...pool,
				...deltas,
			});

			const snapshotDue = state.samples % this.snapshotEvery === 0;
			state.samples += 1;
			if (snapshotDue) {
				try {
					const rows = await client.query(TABLES_SQL);
					let slowQueries: DatabaseSlowQuery[] | undefined;
					if ((target.extensions ?? []).includes('pg_stat_statements')) {
						try {
							const slow = await client.query(SLOW_QUERIES_SQL);
							slowQueries = slow.map(readSlowQuery).filter((query) => query.query.length > 0);
						} catch (error) {
							// The extension may not exist in this image; keep the table snapshot.
							this.log('warn', `Database ${target.id}: slow-query snapshot failed: ${errorText(error)}`);
						}
					}
					this.pushSnapshot({
						databaseId: target.id,
						at: new Date(this.now()).toISOString(),
						tables: rows.slice(0, TABLE_LIMIT).map(readTable),
						...(slowQueries ? { slowQueries } : {}),
					});
				} catch (error) {
					// The bucket is still good; retry the snapshot on the next sample.
					state.samples = 0;
					this.log('warn', `Database ${target.id}: table snapshot failed: ${errorText(error)}`);
				}
			}
			return pushed;
		} catch (error) {
			const detail = scrub(errorText(error), [target.monitor.monitorPassword]);
			this.log('warn', `Database ${target.id}: sample failed: ${detail}`);
			return this.pushBucket(downBucket(target, bucket));
		} finally {
			await client?.close().catch(() => undefined);
		}
	}

	/**
	 * Sample the PgBouncer admin console. This is loopback-only and separate from the database
	 * connection; a pooler failure never marks the database down. `SHOW STATS` is best effort.
	 */
	private async samplePooler(target: DatabaseTarget): Promise<DatabasePoolMetrics> {
		if (!target.pooler) return { ...EMPTY_POOL };
		const password = target.pooler.password;
		let metrics: DatabasePoolMetrics;
		try {
			metrics = parsePoolerPools(await this.poolerCommand(target, POOLER_POOLS_SQL));
		} catch (error) {
			this.log('warn', `Database ${target.id}: pooler sample failed: ${scrub(errorText(error), [password])}`);
			return { ...EMPTY_POOL };
		}
		try {
			metrics = parsePoolerStats(await this.poolerCommand(target, POOLER_STATS_SQL), metrics);
		} catch (error) {
			this.log('warn', `Database ${target.id}: pooler stats failed: ${scrub(errorText(error), [password])}`);
		}
		return metrics;
	}

	/**
	 * One admin-console command on its own connection. Bun's client sends a Flush before a second
	 * query on a connection, and PgBouncer's admin console rejects it ("unsupported packet type
	 * for admin console: 72"), so connections are never reused here.
	 */
	private async poolerCommand(target: DatabaseTarget, command: string): Promise<Array<Record<string, unknown>>> {
		const pooler = target.pooler!;
		const client = this.connect({
			hostname: '127.0.0.1',
			port: pooler.port,
			username: pooler.username,
			password: pooler.password,
			database: 'pgbouncer',
			// The sidecar mirrors the database's TLS mode for client connections.
			...tlsOptions(target),
		});
		try {
			return await client.query(command);
		} finally {
			await client.close().catch(() => undefined);
		}
	}

	private async bootstrap(target: DatabaseTarget, ownerPassword: string): Promise<void> {
		const client = this.connect({
			hostname: '127.0.0.1',
			port: target.port,
			username: target.monitor.ownerUser,
			password: ownerPassword,
			database: target.monitor.databaseName,
			...tlsOptions(target),
		});
		try {
			const [row] = await client.query(BOOTSTRAP_SQL, [
				target.monitor.monitorUser,
				target.monitor.monitorPassword,
			]);
			const statements = [row?.role_sql, row?.monitor_sql, row?.connect_sql];
			for (const statement of statements) {
				if (typeof statement !== 'string' || !statement)
					throw new Error('bootstrap query returned no statement');
				await client.query(statement);
			}
			// Extensions are best-effort: an image without one must not fail the monitor role.
			for (const extension of target.extensions ?? []) {
				const sqlName = extensionSqlName(extension);
				if (!sqlName) continue;
				try {
					// CASCADE pulls in a required extension (earthdistance needs cube); the identifier
					// comes from the contracts catalog, never from the wire.
					await client.query(`CREATE EXTENSION IF NOT EXISTS "${sqlName}" CASCADE`);
				} catch (error) {
					this.log(
						'warn',
						`Database ${target.id}: extension ${extension} is unavailable: ${scrub(errorText(error), [ownerPassword])}`,
					);
				}
			}
		} finally {
			await client.close().catch(() => undefined);
		}
	}

	private pushBucket(bucket: DatabaseMetricBucket): boolean {
		const parsed = databaseMetricBucketSchema.safeParse(bucket);
		if (!parsed.success) {
			this.log('warn', `Dropping an invalid sample for ${bucket.databaseId}: ${parsed.error.message}`);
			return false;
		}
		this.buckets.push(parsed.data);
		const overflow = this.buckets.length - this.maxBuckets;
		if (overflow > 0) {
			this.buckets.splice(0, overflow);
			this.totalDropped += overflow;
		}
		return true;
	}

	/** Only the newest snapshot per database matters; the control plane keeps the latest only. */
	private pushSnapshot(snapshot: DatabaseSnapshot): void {
		const parsed = databaseSnapshotSchema.safeParse(snapshot);
		if (!parsed.success) {
			this.log('warn', `Dropping an invalid table snapshot for ${snapshot.databaseId}: ${parsed.error.message}`);
			return;
		}
		this.snapshots = this.snapshots.filter((existing) => existing.databaseId !== snapshot.databaseId);
		this.snapshots.push(parsed.data);
		const overflow = this.snapshots.length - this.maxSnapshots;
		if (overflow > 0) {
			this.snapshots.splice(0, overflow);
			this.totalDropped += overflow;
		}
	}
}

function tlsOptions(target: DatabaseTarget): Pick<SqlConnectOptions, 'tls'> {
	if (!target.tls) return {};
	return {
		tls: target.tls.caPem
			? { ca: target.tls.caPem, rejectUnauthorized: true }
			: { rejectUnauthorized: false },
	};
}

function downBucket(target: DatabaseTarget, bucket: string): DatabaseMetricBucket {
	return {
		databaseId: target.id,
		bucket,
		up: false,
		sizeBytes: 0,
		connectionsActive: 0,
		connectionsIdle: 0,
		connectionsTotal: 0,
		maxConnections: 0,
		memoryBytes: int(target.memoryBytes),
		...EMPTY_POOL,
		...zeroCounters(),
	};
}

function zeroCounters(): Counters {
	return Object.fromEntries(COUNTERS.map((name) => [name, 0])) as Counters;
}

function readCounters(row: Record<string, unknown>): Counters {
	return Object.fromEntries(COUNTERS.map((name) => [name, int(row[COUNTER_COLUMNS[name]])])) as Counters;
}

/**
 * Per-minute deltas. The first sample has no baseline and reports 0; a counter that went
 * backwards (stats reset, crash recovery) reports its raw value, which is what accrued since.
 */
export function counterDeltas(previous: Counters | null, current: Counters): Counters {
	if (!previous) return zeroCounters();
	return Object.fromEntries(
		COUNTERS.map((name) => {
			const delta = current[name] - previous[name];
			return [name, delta < 0 ? current[name] : delta];
		}),
	) as Counters;
}

function readSlowQuery(row: Record<string, unknown>): DatabaseSlowQuery {
	return {
		queryId: String(row.query_id ?? '').slice(0, 40),
		// pg_stat_statements normalizes literals to placeholders; trim identifiers defensively.
		query: String(row.query ?? '').replace(/[\u0000-\u001f]+/g, ' ').slice(0, 2_000),
		calls: int(row.calls),
		totalMs: number(row.total_ms),
		meanMs: number(row.mean_ms),
		rows: int(row.rows),
		sharedBlocks: int(row.shared_blocks),
		tempBlocks: int(row.temp_blocks),
	};
}

function number(value: unknown): number {
	const parsed = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readTable(row: Record<string, unknown>): DatabaseTableStat {
	return {
		schema: String(row.schema ?? '').slice(0, 128),
		name: String(row.name ?? '').slice(0, 128),
		rows: int(row.rows),
		totalBytes: int(row.total_bytes),
		seqScans: int(row.seq_scans),
		idxScans: int(row.idx_scans),
		lastAutovacuum: timestamp(row.last_autovacuum),
		lastAutoanalyze: timestamp(row.last_autoanalyze),
	};
}

/** Postgres numerics arrive as number, string or bigint depending on the type and driver. */
function int(value: unknown): number {
	const number = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
	return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function timestamp(value: unknown): string | null {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
	if (typeof value === 'string' && value) return value.slice(0, 40);
	return null;
}

/** Driver errors should never echo a statement, but a password must not reach a log either way. */
function scrub(message: string, secrets: Array<string | null>): string {
	let scrubbed = message;
	for (const secret of secrets) if (secret) scrubbed = scrubbed.split(secret).join('***');
	return scrubbed;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

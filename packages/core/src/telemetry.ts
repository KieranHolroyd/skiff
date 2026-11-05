import type { DuckDBAppender, DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import type {
	DatabaseMetricBucket,
	DatabaseMetricPoint,
	MetricBucket,
	StorageMetricBucket,
	StorageMetricPoint,
} from '@skiff/contracts';
import {
	ST_COLUMNS,
	ST_GAUGES,
	ST_LATEST_SQL,
	ST_ROLLUP_DELETE_SQL,
	ST_ROLLUP_INSERT_SQL,
	storageMetricsTableSql,
	storageSeriesSql,
} from './storage-metrics-sql.ts';
import {
	DB_COLUMNS,
	DB_COUNTERS,
	DB_GAUGES,
	DB_LATEST_SQL,
	DB_ROLLUP_DELETE_SQL,
	DB_ROLLUP_INSERT_SQL,
	dbMetricsTableSql,
	dbSeriesSql,
} from './database-metrics-sql.ts';
import { mkdir, readFile, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { ObjectStore } from './object-store.ts';

/**
 * Telemetry hot store (DESIGN §8, D15, D16). Agents send pre-aggregated 1-minute
 * buckets; DuckDB keeps 48 h of them, rolls them into hourly rows for 90 days and
 * archives day-partitioned Parquet to the object store.
 *
 * Every public method is fail-open: telemetry is an observability aid, so a broken
 * DuckDB (or a missing native binding) must never stop the control plane booting or
 * a deploy from completing. Failures are reported through the injected `onError`.
 */

export type TelemetryInterval = '1m' | '1h';

/** Timestamps accepted by query/export. Numbers are Unix epoch milliseconds. */
export type TimeInput = string | number | Date;

export interface MetricPoint {
	bucket: string;
	host: string;
	projectId: string | null;
	requests: number;
	status2xx: number;
	status3xx: number;
	status4xx: number;
	status5xx: number;
	bytes: number;
	durationP50Ms: number;
	durationP95Ms: number;
}

export interface TelemetryQuery {
	host?: string;
	projectId?: string;
	/** Restrict to a set of projects (an empty array matches nothing). */
	projectIds?: string[];
	from: TimeInput;
	to: TimeInput;
	interval: TelemetryInterval;
}

/** Totals for one dashboard range, aggregated across every matching host. */
export interface TrafficTotals {
	requests: number;
	bytes: number;
	status2xx: number;
	status3xx: number;
	status4xx: number;
	status5xx: number;
	/** Request-weighted latency estimate for the whole range. */
	durationP50Ms: number;
	durationP95Ms: number;
}

export interface TrafficSeriesPoint extends TrafficTotals {
	bucket: string;
}

/** One host or project in a traffic breakdown. `key` is the host name or project id. */
export interface TrafficBreakdownRow {
	key: string;
	requests: number;
	bytes: number;
	status4xx: number;
	status5xx: number;
	durationP95Ms: number;
}

export interface TrafficTopEntry {
	key: string;
	count: number;
}

/**
 * Everything one dashboard needs from DuckDB in a single round trip: totals, a gap-filled
 * time series, per-host/per-project breakdowns and the busiest paths/referrers.
 */
export interface TrafficReport {
	totals: TrafficTotals;
	series: TrafficSeriesPoint[];
	hosts: TrafficBreakdownRow[];
	projects: TrafficBreakdownRow[];
	topPaths: TrafficTopEntry[];
	topReferrers: TrafficTopEntry[];
}

export interface DatabaseMetricsQuery {
	databaseId: string;
	from: TimeInput;
	to: TimeInput;
	interval: TelemetryInterval;
}

export interface DatabaseLatestSample {
	databaseId: string;
	up: boolean;
	sizeBytes: number;
	connectionsTotal: number;
	maxConnections: number;
	memoryBytes: number;
}

export interface StorageMetricsQuery {
	storageId: string;
	from: TimeInput;
	to: TimeInput;
	interval: TelemetryInterval;
}

export interface TrafficReportQuery extends TelemetryQuery {
	/** How many path/referrer entries to return (default 10). */
	topLimit?: number;
}

export interface PruneOptions {
	/** Keep 1-minute buckets for this many hours (default 48). */
	rawHours?: number;
	/** Keep 1-hour buckets for this many days (default 90). */
	hourlyDays?: number;
}

export interface ParquetExportOptions {
	from: TimeInput;
	to: TimeInput;
	/** Local output directory. DuckDB writes `day=YYYY-MM-DD/*.parquet` below it. */
	dir: string;
	/** Overrides the store-level object store. Local files are deleted after upload. */
	objectStore?: ObjectStore;
}

export interface TelemetryOptions {
	/** File path, or `:memory:` for tests. */
	path: string;
	memoryLimitMb?: number;
	threads?: number;
	/** 1-minute retention in hours (default 48). Rollups only rewrite hours fully inside it. */
	rawRetentionHours?: number;
	objectStore?: ObjectStore;
	/** Called for every swallowed telemetry failure. */
	onError?: (error: Error) => void;
	/** Injected clock (tests and deterministic rollups). */
	now?: () => number;
	/** Test seam for simulating a missing/broken `@duckdb/node-api`. */
	loadDuckDb?: () => Promise<typeof import('@duckdb/node-api')>;
}

type DuckDbApi = typeof import('@duckdb/node-api');

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TOP_N = 10;

const defaultLoadDuckDb: () => Promise<DuckDbApi> = () => import('@duckdb/node-api');

const metricsTableSql = (table: string): string => `
	CREATE TABLE IF NOT EXISTS ${table} (
		host VARCHAR NOT NULL,
		project_id VARCHAR,
		bucket TIMESTAMPTZ NOT NULL,
		requests UBIGINT NOT NULL,
		status_2xx UBIGINT NOT NULL,
		status_3xx UBIGINT NOT NULL,
		status_4xx UBIGINT NOT NULL,
		status_5xx UBIGINT NOT NULL,
		bytes UBIGINT NOT NULL,
		duration_p50_ms DOUBLE NOT NULL,
		duration_p95_ms DOUBLE NOT NULL,
		top_paths JSON NOT NULL,
		top_referrers JSON NOT NULL
	)`;

const ROLLUP_TABLE = '_telemetry_rollup';

const ROLLUP_CREATE_SQL = `
	CREATE OR REPLACE TEMP TABLE ${ROLLUP_TABLE} AS
	WITH src AS (
		SELECT date_trunc('hour', bucket) AS bucket, host, project_id,
			sum(requests)::UBIGINT AS requests,
			sum(status_2xx)::UBIGINT AS status_2xx,
			sum(status_3xx)::UBIGINT AS status_3xx,
			sum(status_4xx)::UBIGINT AS status_4xx,
			sum(status_5xx)::UBIGINT AS status_5xx,
			sum(bytes)::UBIGINT AS bytes,
			COALESCE(
				sum(duration_p50_ms * CAST(requests AS DOUBLE)) / NULLIF(sum(CAST(requests AS DOUBLE)), 0),
				0
			) AS duration_p50_ms,
			COALESCE(
				sum(duration_p95_ms * CAST(requests AS DOUBLE)) / NULLIF(sum(CAST(requests AS DOUBLE)), 0),
				0
			) AS duration_p95_ms
		FROM metrics_1m
		WHERE bucket >= CAST(? AS TIMESTAMPTZ)
			AND bucket < date_trunc('hour', CAST(? AS TIMESTAMPTZ))
		GROUP BY date_trunc('hour', bucket), host, project_id
	), paths AS (
		SELECT bucket, host, project_id,
			to_json(list(json_object('path', path, 'count', count) ORDER BY count DESC)) AS top_paths
		FROM (
			SELECT date_trunc('hour', bucket) AS bucket, host, project_id,
				json_extract_string(p, '$.path') AS path,
				sum(CAST(json_extract(p, '$.count') AS UBIGINT)) AS count,
				row_number() OVER (
					PARTITION BY date_trunc('hour', bucket), host, project_id
					ORDER BY sum(CAST(json_extract(p, '$.count') AS UBIGINT)) DESC
				) AS rn
			FROM metrics_1m, unnest(from_json(top_paths, '["JSON"]')) AS u(p)
			WHERE bucket >= CAST(? AS TIMESTAMPTZ)
				AND bucket < date_trunc('hour', CAST(? AS TIMESTAMPTZ))
			GROUP BY date_trunc('hour', bucket), host, project_id, json_extract_string(p, '$.path')
		)
		WHERE rn <= ${TOP_N}
		GROUP BY bucket, host, project_id
	), referrers AS (
		SELECT bucket, host, project_id,
			to_json(list(json_object('referrer', referrer, 'count', count) ORDER BY count DESC)) AS top_referrers
		FROM (
			SELECT date_trunc('hour', bucket) AS bucket, host, project_id,
				json_extract_string(p, '$.referrer') AS referrer,
				sum(CAST(json_extract(p, '$.count') AS UBIGINT)) AS count,
				row_number() OVER (
					PARTITION BY date_trunc('hour', bucket), host, project_id
					ORDER BY sum(CAST(json_extract(p, '$.count') AS UBIGINT)) DESC
				) AS rn
			FROM metrics_1m, unnest(from_json(top_referrers, '["JSON"]')) AS u(p)
			WHERE bucket >= CAST(? AS TIMESTAMPTZ)
				AND bucket < date_trunc('hour', CAST(? AS TIMESTAMPTZ))
			GROUP BY date_trunc('hour', bucket), host, project_id, json_extract_string(p, '$.referrer')
		)
		WHERE rn <= ${TOP_N}
		GROUP BY bucket, host, project_id
	)
	SELECT s.bucket, s.host, s.project_id, s.requests, s.status_2xx, s.status_3xx,
		s.status_4xx, s.status_5xx, s.bytes, s.duration_p50_ms, s.duration_p95_ms,
		COALESCE(p.top_paths, '[]'::JSON) AS top_paths,
		COALESCE(r.top_referrers, '[]'::JSON) AS top_referrers
	FROM src s
	LEFT JOIN paths p USING (bucket, host, project_id)
	LEFT JOIN referrers r USING (bucket, host, project_id)`;

/** Replace only the host/hour pairs being recomputed, so repeated rollups are idempotent. */
const ROLLUP_DELETE_SQL = `
	DELETE FROM metrics_1h USING (
		SELECT DISTINCT host, date_trunc('hour', bucket) AS bucket
		FROM metrics_1m
		WHERE bucket >= CAST(? AS TIMESTAMPTZ)
			AND bucket < date_trunc('hour', CAST(? AS TIMESTAMPTZ))
	) s
	WHERE metrics_1h.host = s.host AND metrics_1h.bucket = s.bucket`;

const ROLLUP_INSERT_SQL = `
	INSERT INTO metrics_1h (
		host, project_id, bucket, requests, status_2xx, status_3xx, status_4xx,
		status_5xx, bytes, duration_p50_ms, duration_p95_ms, top_paths, top_referrers
	)
	SELECT host, project_id, bucket, requests, status_2xx, status_3xx, status_4xx,
		status_5xx, bytes, duration_p50_ms, duration_p95_ms, top_paths, top_referrers
	FROM ${ROLLUP_TABLE}`;

interface IngestRow {
	host: string;
	projectId: string | null;
	bucketMs: number;
	requests: bigint;
	status2xx: bigint;
	status3xx: bigint;
	status4xx: bigint;
	status5xx: bigint;
	bytes: bigint;
	durationP50Ms: number;
	durationP95Ms: number;
	topPaths: string;
	topReferrers: string;
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function toEpochMs(value: TimeInput): number {
	const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
	if (!Number.isFinite(ms)) throw new Error(`Invalid timestamp: ${String(value)}`);
	return ms;
}

function isoFromMs(ms: number): string {
	return new Date(ms).toISOString();
}

function floorToMinute(ms: number): number {
	return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** UBIGINT via the appender needs a bigint; clamp nonsense rather than failing a whole batch. */
function toBigCount(value: number): bigint {
	if (!Number.isFinite(value) || value <= 0) return 0n;
	return BigInt(Math.trunc(value));
}

function toDouble(value: number): number {
	return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** DuckDB's JSON value converter returns UBIGINT/BIGINT as strings. */
function readNumber(value: unknown): number {
	if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
	if (typeof value === 'bigint') return Number(value);
	if (typeof value === 'string') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

function readString(value: unknown): string {
	return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function toMetricPoint(row: Record<string, unknown>): MetricPoint {
	return {
		bucket: isoFromMs(readNumber(row['bucket_ms'])),
		host: readString(row['host']),
		projectId: row['project_id'] == null ? null : readString(row['project_id']),
		requests: readNumber(row['requests']),
		status2xx: readNumber(row['status_2xx']),
		status3xx: readNumber(row['status_3xx']),
		status4xx: readNumber(row['status_4xx']),
		status5xx: readNumber(row['status_5xx']),
		bytes: readNumber(row['bytes']),
		durationP50Ms: readNumber(row['duration_p50_ms']),
		durationP95Ms: readNumber(row['duration_p95_ms']),
	};
}

export function emptyTrafficReport(): TrafficReport {
	return {
		totals: {
			requests: 0,
			bytes: 0,
			status2xx: 0,
			status3xx: 0,
			status4xx: 0,
			status5xx: 0,
			durationP50Ms: 0,
			durationP95Ms: 0,
		},
		series: [],
		hosts: [],
		projects: [],
		topPaths: [],
		topReferrers: [],
	};
}

function emptyTotals(): TrafficTotals {
	return {
		requests: 0,
		bytes: 0,
		status2xx: 0,
		status3xx: 0,
		status4xx: 0,
		status5xx: 0,
		durationP50Ms: 0,
		durationP95Ms: 0,
	};
}

interface TotalsAccumulator extends TrafficTotals {
	p50Weighted: number;
	p95Weighted: number;
}

function emptyAccumulator(): TotalsAccumulator {
	return { ...emptyTotals(), p50Weighted: 0, p95Weighted: 0 };
}

function accumulate(acc: TotalsAccumulator, point: TrafficTotals): void {
	acc.requests += point.requests;
	acc.bytes += point.bytes;
	acc.status2xx += point.status2xx;
	acc.status3xx += point.status3xx;
	acc.status4xx += point.status4xx;
	acc.status5xx += point.status5xx;
	acc.p50Weighted += point.durationP50Ms * point.requests;
	acc.p95Weighted += point.durationP95Ms * point.requests;
}

function finishTotals(acc: TotalsAccumulator): TrafficTotals {
	return {
		requests: acc.requests,
		bytes: acc.bytes,
		status2xx: acc.status2xx,
		status3xx: acc.status3xx,
		status4xx: acc.status4xx,
		status5xx: acc.status5xx,
		durationP50Ms: acc.requests > 0 ? acc.p50Weighted / acc.requests : 0,
		durationP95Ms: acc.requests > 0 ? acc.p95Weighted / acc.requests : 0,
	};
}

function intervalMs(interval: TelemetryInterval): number {
	return interval === '1h' ? HOUR_MS : MINUTE_MS;
}

function floorToMs(value: string, step: number): number {
	return Math.floor(toEpochMs(value) / step) * step;
}

function upsertAccumulator(
	map: Map<string | number, TotalsAccumulator>,
	key: string | number,
	point: TrafficTotals,
): void {
	const current = map.get(key);
	if (current) {
		accumulate(current, point);
		return;
	}
	const created = emptyAccumulator();
	accumulate(created, point);
	map.set(key, created);
}

function finishBreakdown(map: Map<string | number, TotalsAccumulator>): TrafficBreakdownRow[] {
	return [...map.entries()]
		.map(([key, acc]) => {
			const totals = finishTotals(acc);
			return {
				key: String(key),
				requests: totals.requests,
				bytes: totals.bytes,
				status4xx: totals.status4xx,
				status5xx: totals.status5xx,
				durationP95Ms: totals.durationP95Ms,
			};
		})
		.sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key));
}

/** Fill quiet minutes/hours with zeros so the chart has a continuous baseline. */
function fillSeries(
	map: Map<string | number, TotalsAccumulator>,
	fromMs: number,
	toMs: number,
	step: number,
): TrafficSeriesPoint[] {
	const start = Math.floor(fromMs / step) * step;
	const end = Math.floor(toMs / step) * step;
	if (end < start) return [];
	const count = Math.floor((end - start) / step) + 1;
	// A pathological range must not allocate millions of points for a dashboard.
	if (count > 20_000) {
		return [...map.entries()]
			.sort(([a], [b]) => Number(a) - Number(b))
			.map(([bucketMs, acc]) => ({
				bucket: isoFromMs(Number(bucketMs)),
				...finishTotals(acc),
			}));
	}
	const series: TrafficSeriesPoint[] = [];
	for (let index = 0; index < count; index++) {
		const bucketMs = start + index * step;
		series.push({
			bucket: isoFromMs(bucketMs),
			...finishTotals(map.get(bucketMs) ?? emptyAccumulator()),
		});
	}
	return series;
}

function escapeSqlString(value: string): string {
	return value.replaceAll("'", "''");
}

function escapePrometheusLabel(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function prometheusNumber(value: number): string {
	return Number.isFinite(value) ? String(value) : '0';
}

export class TelemetryStore {
	readonly #path: string;
	readonly #memoryLimitMb: number;
	readonly #threads: number;
	readonly #rawRetentionHours: number;
	readonly #objectStore: ObjectStore | undefined;
	readonly #onError: ((error: Error) => void) | undefined;
	readonly #now: () => number;
	readonly #loadDuckDb: () => Promise<DuckDbApi>;

	#instance: DuckDBInstance | undefined;
	#connection: DuckDBConnection | undefined;
	#openPromise: Promise<void> | undefined;
	#writeTail: Promise<void> = Promise.resolve();
	#closed = false;

	/** Whether daily Parquet partitions can be archived (an object store is configured). */
	get archiveEnabled(): boolean {
		return this.#objectStore !== undefined;
	}

	/** True once DuckDB opened and the schema was created. */
	available = false;
	/** The fatal open error, or the most recent swallowed operation error. */
	error: Error | null = null;

	constructor(options: TelemetryOptions) {
		this.#path = options.path;
		this.#memoryLimitMb = options.memoryLimitMb ?? 256;
		this.#threads = options.threads ?? 2;
		this.#rawRetentionHours = options.rawRetentionHours ?? 48;
		this.#objectStore = options.objectStore;
		this.#onError = options.onError;
		this.#now = options.now ?? Date.now;
		this.#loadDuckDb = options.loadDuckDb ?? defaultLoadDuckDb;
	}

	/** Lazily open DuckDB. A load/open failure leaves the store in no-op mode. */
	async open(): Promise<void> {
		if (this.#closed) return;
		if (this.#openPromise) return this.#openPromise;
		this.#openPromise = this.#doOpen();
		return this.#openPromise;
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.available = false;
		const connection = this.#connection;
		this.#connection = undefined;
		try {
			connection?.closeSync();
		} catch (error) {
			this.#report('close', error);
		}
		const instance = this.#instance;
		this.#instance = undefined;
		try {
			instance?.closeSync();
		} catch (error) {
			this.#report('close', error);
		}
	}

	async ingest(buckets: MetricBucket[]): Promise<{ inserted: number }> {
		return this.#guarded('ingest', { inserted: 0 }, async () => {
			const rows = new Map<string, IngestRow>();
			for (const bucket of buckets) {
				const bucketMs = floorToMinute(toEpochMs(bucket.bucket));
				const projectId = bucket.projectId ?? null;
				rows.set(`${bucket.host}\u0000${bucketMs}`, {
					host: bucket.host,
					projectId,
					bucketMs,
					requests: toBigCount(bucket.requests),
					status2xx: toBigCount(bucket.status2xx),
					status3xx: toBigCount(bucket.status3xx),
					status4xx: toBigCount(bucket.status4xx),
					status5xx: toBigCount(bucket.status5xx),
					bytes: toBigCount(bucket.bytes),
					durationP50Ms: toDouble(bucket.durationP50Ms),
					durationP95Ms: toDouble(bucket.durationP95Ms),
					topPaths: JSON.stringify(bucket.topPaths ?? []),
					topReferrers: JSON.stringify(bucket.topReferrers ?? []),
				});
			}
			if (rows.size === 0) return { inserted: 0 };
			const values = [...rows.values()];

			return this.#serialize(async () => {
				const connection = this.#requireWriteConnection();
				let appender: DuckDBAppender | undefined;
				await connection.run('BEGIN TRANSACTION');
				try {
					const placeholders = values.map(() => '(?, CAST(? AS TIMESTAMPTZ))').join(', ');
					const params: string[] = [];
					for (const row of values) params.push(row.host, isoFromMs(row.bucketMs));
					await connection.run(
						`DELETE FROM metrics_1m WHERE (host, bucket) IN (${placeholders})`,
						params,
					);

					appender = await connection.createAppender('metrics_1m');
					for (const row of values) {
						appender.appendVarchar(row.host);
						if (row.projectId === null) appender.appendNull();
						else appender.appendVarchar(row.projectId);
						appender.appendVarchar(isoFromMs(row.bucketMs));
						appender.appendUBigInt(row.requests);
						appender.appendUBigInt(row.status2xx);
						appender.appendUBigInt(row.status3xx);
						appender.appendUBigInt(row.status4xx);
						appender.appendUBigInt(row.status5xx);
						appender.appendUBigInt(row.bytes);
						appender.appendDouble(row.durationP50Ms);
						appender.appendDouble(row.durationP95Ms);
						appender.appendVarchar(row.topPaths);
						appender.appendVarchar(row.topReferrers);
						appender.endRow();
					}
					appender.closeSync();
					appender = undefined;
					await connection.run('COMMIT');
				} catch (error) {
					try {
						appender?.closeSync();
					} catch {
						// The original error is more useful.
					}
					try {
						await connection.run('ROLLBACK');
					} catch {
						// Already rolled back or the connection is gone.
					}
					throw error;
				}
				return { inserted: values.length };
			});
		});
	}

	async query(input: TelemetryQuery): Promise<MetricPoint[]> {
		return this.#guarded('query', [], async () => {
			const fromMs = toEpochMs(input.from);
			const toMs = toEpochMs(input.to);
			if (toMs < fromMs) return [];
			const interval = input.interval === '1h' ? '1 hour' : '1 minute';
			const source = this.#sourceFor(input);

			const sql = `
				SELECT epoch_ms(time_bucket(INTERVAL '${interval}', bucket)) AS bucket_ms,
					host, project_id,
					CAST(sum(requests) AS DOUBLE) AS requests,
					CAST(sum(status_2xx) AS DOUBLE) AS status_2xx,
					CAST(sum(status_3xx) AS DOUBLE) AS status_3xx,
					CAST(sum(status_4xx) AS DOUBLE) AS status_4xx,
					CAST(sum(status_5xx) AS DOUBLE) AS status_5xx,
					CAST(sum(bytes) AS DOUBLE) AS bytes,
					COALESCE(
						sum(duration_p50_ms * CAST(requests AS DOUBLE)) / NULLIF(sum(CAST(requests AS DOUBLE)), 0),
						0
					) AS duration_p50_ms,
					COALESCE(
						sum(duration_p95_ms * CAST(requests AS DOUBLE)) / NULLIF(sum(CAST(requests AS DOUBLE)), 0),
						0
					) AS duration_p95_ms
				FROM ${source.sql} AS src
				GROUP BY time_bucket(INTERVAL '${interval}', bucket), host, project_id
				ORDER BY bucket_ms ASC, host ASC, project_id ASC`;

			return this.#withReadConnection(async (connection) => {
				const result = await connection.runAndReadAll(sql, source.params);
				return result.getRowObjectsJson().map((row) => toMetricPoint(row));
			});
		});
	}

	/**
	 * Dashboard projection of the same hot store. Totals, series, host/project breakdowns and
	 * top paths/referrers come from two DuckDB reads instead of one per card.
	 */
	async report(input: TrafficReportQuery): Promise<TrafficReport> {
		return this.#guarded('report', emptyTrafficReport(), async () => {
			const fromMs = toEpochMs(input.from);
			const toMs = toEpochMs(input.to);
			if (toMs < fromMs) return emptyTrafficReport();

			const points = await this.query(input);
			const step = intervalMs(input.interval);
			const byBucket = new Map<string | number, TotalsAccumulator>();
			const byHost = new Map<string | number, TotalsAccumulator>();
			const byProject = new Map<string | number, TotalsAccumulator>();
			const totals = emptyAccumulator();

			for (const point of points) {
				accumulate(totals, point);
				const bucketMs = floorToMs(point.bucket, step);
				upsertAccumulator(byBucket, bucketMs, point);
				upsertAccumulator(byHost, point.host, point);
				if (point.projectId) upsertAccumulator(byProject, point.projectId, point);
			}

			const topLimit = Math.min(Math.max(input.topLimit ?? 10, 1), 100);
			const top = await this.#topEntries(input, topLimit);

			return {
				totals: finishTotals(totals),
				series: fillSeries(byBucket, fromMs, toMs, step),
				hosts: finishBreakdown(byHost),
				projects: finishBreakdown(byProject),
				topPaths: top.paths,
				topReferrers: top.referrers,
			};
		});
	}

	/** Shared `metrics_1h ∪ metrics_1m` source for dashboard queries, with filters applied. */
	#sourceFor(input: TelemetryQuery): { sql: string; params: string[] } {
		const fromMs = toEpochMs(input.from);
		const toMs = toEpochMs(input.to);
		const filters: string[] = [];
		const filterParams: string[] = [];
		if (input.host !== undefined) {
			filters.push('host = ?');
			filterParams.push(input.host);
		}
		if (input.projectId !== undefined) {
			filters.push('project_id = ?');
			filterParams.push(input.projectId);
		}
		if (input.projectIds !== undefined) {
			if (input.projectIds.length === 0) {
				filters.push('false');
			} else {
				filters.push(`project_id IN (${input.projectIds.map(() => '?').join(', ')})`);
				filterParams.push(...input.projectIds);
			}
		}
		const where = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';

		// Hourly queries read metrics_1h wherever an hour has been rolled up (1-minute rows
		// are pruned after 48 h) and fall back to 1-minute rows for hours not rolled yet,
		// such as the current one. Minute queries only have 1-minute data to read.
		if (input.interval === '1h') {
			return {
				sql: `(
					SELECT * FROM metrics_1h
					WHERE bucket >= date_trunc('hour', CAST(? AS TIMESTAMPTZ)) AND bucket <= CAST(? AS TIMESTAMPTZ)
						${where}
					UNION ALL
					SELECT * FROM metrics_1m m
					WHERE bucket >= CAST(? AS TIMESTAMPTZ) AND bucket <= CAST(? AS TIMESTAMPTZ)
						${where}
						AND NOT EXISTS (
							SELECT 1 FROM metrics_1h h
							WHERE h.host = m.host AND h.bucket = date_trunc('hour', m.bucket)
						)
				)`,
				params: [
					isoFromMs(fromMs),
					isoFromMs(toMs),
					...filterParams,
					isoFromMs(fromMs),
					isoFromMs(toMs),
					...filterParams,
				],
			};
		}
		return {
			sql: `(
				SELECT * FROM metrics_1m
				WHERE bucket >= CAST(? AS TIMESTAMPTZ) AND bucket <= CAST(? AS TIMESTAMPTZ)
					${where}
			)`,
			params: [isoFromMs(fromMs), isoFromMs(toMs), ...filterParams],
		};
	}

	async #topEntries(
		input: TelemetryQuery,
		limit: number,
	): Promise<{ paths: TrafficTopEntry[]; referrers: TrafficTopEntry[] }> {
		const source = this.#sourceFor(input);
		const pathsSql = `
			SELECT json_extract_string(entry, '$.path') AS key,
				CAST(sum(CAST(json_extract(entry, '$.count') AS UBIGINT)) AS DOUBLE) AS count
			FROM ${source.sql} AS src, unnest(from_json(top_paths, '["JSON"]')) AS u(entry)
			GROUP BY key
			ORDER BY count DESC, key ASC
			LIMIT ?`;
		const referrersSql = `
			SELECT json_extract_string(entry, '$.referrer') AS key,
				CAST(sum(CAST(json_extract(entry, '$.count') AS UBIGINT)) AS DOUBLE) AS count
			FROM ${source.sql} AS src, unnest(from_json(top_referrers, '["JSON"]')) AS u(entry)
			GROUP BY key
			ORDER BY count DESC, key ASC
			LIMIT ?`;

		return this.#withReadConnection(async (connection) => {
			const paths = await connection.runAndReadAll(pathsSql, [...source.params, limit]);
			const referrers = await connection.runAndReadAll(referrersSql, [...source.params, limit]);
			const toEntries = (result: typeof paths) =>
				result
					.getRowObjectsJson()
					.filter((row) => row['key'] != null)
					.map((row) => ({ key: readString(row['key']), count: readNumber(row['count']) }));
			return { paths: toEntries(paths), referrers: toEntries(referrers) };
		});
	}

	/** Managed-database minute samples (D57). Re-sending a minute replaces it. */
	async ingestDatabaseMetrics(buckets: DatabaseMetricBucket[]): Promise<{ inserted: number }> {
		return this.#guarded('ingestDatabaseMetrics', { inserted: 0 }, async () => {
			const rows = new Map<string, DatabaseMetricBucket & { bucketMs: number }>();
			for (const bucket of buckets) {
				const bucketMs = floorToMinute(toEpochMs(bucket.bucket));
				rows.set(`${bucket.databaseId}\u0000${bucketMs}`, { ...bucket, bucketMs });
			}
			if (rows.size === 0) return { inserted: 0 };
			const values = [...rows.values()];
			return this.#serialize(async () => {
				const connection = this.#requireWriteConnection();
				await connection.run('BEGIN TRANSACTION');
				try {
					for (let start = 0; start < values.length; start += 200) {
						const chunk = values.slice(start, start + 200);
						const keys = chunk.map(() => '(?, CAST(? AS TIMESTAMPTZ))').join(', ');
						const keyParams: string[] = [];
						for (const row of chunk) keyParams.push(row.databaseId, isoFromMs(row.bucketMs));
						await connection.run(`DELETE FROM db_metrics_1m WHERE (database_id, bucket) IN (${keys})`, keyParams);
						const rowSql = `(?, CAST(? AS TIMESTAMPTZ), ${DB_COLUMNS.slice(2).map(() => '?').join(', ')})`;
						const params: Array<string | number> = [];
						for (const row of chunk) {
							params.push(row.databaseId, isoFromMs(row.bucketMs));
							for (const [, key] of DB_GAUGES) params.push(key === 'up' ? (row.up ? 1 : 0) : toDouble(row[key]));
							for (const [, key] of DB_COUNTERS) params.push(Math.max(0, Math.trunc(row[key] ?? 0)));
						}
						await connection.run(
							`INSERT INTO db_metrics_1m (${DB_COLUMNS.join(', ')}) VALUES ${chunk.map(() => rowSql).join(', ')}`,
							params,
						);
					}
					await connection.run('COMMIT');
				} catch (error) {
					try {
						await connection.run('ROLLBACK');
					} catch {
						// Already rolled back or the connection is gone.
					}
					throw error;
				}
				return { inserted: values.length };
			});
		});
	}

	async queryDatabaseMetrics(input: DatabaseMetricsQuery): Promise<DatabaseMetricPoint[]> {
		return this.#guarded('queryDatabaseMetrics', [], async () => {
			const fromMs = toEpochMs(input.from);
			const toMs = toEpochMs(input.to);
			if (toMs < fromMs) return [];
			const range = [input.databaseId, isoFromMs(fromMs), isoFromMs(toMs)];
			const params = input.interval === '1h' ? [...range, ...range] : range;
			return this.#withReadConnection(async (connection) => {
				const result = await connection.runAndReadAll(dbSeriesSql(input.interval), params);
				return result.getRowObjectsJson().map((row) => {
					const point = { bucket: isoFromMs(readNumber(row['bucket_ms'])) } as Record<string, unknown>;
					for (const [column, key] of [...DB_GAUGES, ...DB_COUNTERS]) point[key] = readNumber(row[column]);
					return point as unknown as DatabaseMetricPoint;
				});
			});
		});
	}

	/** Managed object storage minute samples (S7). Re-sending a minute replaces it. */
	async ingestStorageMetrics(buckets: StorageMetricBucket[]): Promise<{ inserted: number }> {
		return this.#guarded('ingestStorageMetrics', { inserted: 0 }, async () => {
			const rows = new Map<string, StorageMetricBucket & { bucketMs: number }>();
			for (const bucket of buckets) {
				const bucketMs = floorToMinute(toEpochMs(bucket.bucket));
				rows.set(`${bucket.storageId}\u0000${bucketMs}`, { ...bucket, bucketMs });
			}
			if (rows.size === 0) return { inserted: 0 };
			const values = [...rows.values()];
			return this.#serialize(async () => {
				const connection = this.#requireWriteConnection();
				await connection.run('BEGIN TRANSACTION');
				try {
					for (let start = 0; start < values.length; start += 200) {
						const chunk = values.slice(start, start + 200);
						const keys = chunk.map(() => '(?, CAST(? AS TIMESTAMPTZ))').join(', ');
						const keyParams: string[] = [];
						for (const row of chunk) keyParams.push(row.storageId, isoFromMs(row.bucketMs));
						await connection.run(`DELETE FROM storage_metrics_1m WHERE (storage_id, bucket) IN (${keys})`, keyParams);
						const rowSql = `(?, CAST(? AS TIMESTAMPTZ), ${ST_COLUMNS.slice(2).map(() => '?').join(', ')})`;
						const params: Array<string | number> = [];
						for (const row of chunk) {
							params.push(row.storageId, isoFromMs(row.bucketMs));
							for (const [, key] of ST_GAUGES) params.push(key === 'up' ? (row.up ? 1 : 0) : toDouble(row[key]));
						}
						await connection.run(
							`INSERT INTO storage_metrics_1m (${ST_COLUMNS.join(', ')}) VALUES ${chunk.map(() => rowSql).join(', ')}`,
							params,
						);
					}
					await connection.run('COMMIT');
				} catch (error) {
					try {
						await connection.run('ROLLBACK');
					} catch {
						// Already rolled back or the connection is gone.
					}
					throw error;
				}
				return { inserted: values.length };
			});
		});
	}

	async queryStorageMetrics(input: StorageMetricsQuery): Promise<StorageMetricPoint[]> {
		return this.#guarded('queryStorageMetrics', [], async () => {
			const fromMs = toEpochMs(input.from);
			const toMs = toEpochMs(input.to);
			if (toMs < fromMs) return [];
			const range = [input.storageId, isoFromMs(fromMs), isoFromMs(toMs)];
			const params = input.interval === '1h' ? [...range, ...range] : range;
			return this.#withReadConnection(async (connection) => {
				const result = await connection.runAndReadAll(storageSeriesSql(input.interval), params);
				return result.getRowObjectsJson().map((row) => {
					const point = { bucket: isoFromMs(readNumber(row['bucket_ms'])) } as Record<string, unknown>;
					for (const [column, key] of ST_GAUGES) point[key] = readNumber(row[column]);
					return point as unknown as StorageMetricPoint;
				});
			});
		});
	}

	/** Newest sample per database since `sinceMs` (alerts and `/metrics`). */
	async latestDatabaseMetrics(sinceMs: number): Promise<DatabaseLatestSample[]> {
		return this.#guarded('latestDatabaseMetrics', [], async () =>
			this.#withReadConnection(async (connection) => {
				const result = await connection.runAndReadAll(DB_LATEST_SQL, [isoFromMs(sinceMs)]);
				return result.getRowObjectsJson().map((row) => ({
					databaseId: readString(row['database_id']),
					up: readNumber(row['up']) >= 0.5,
					sizeBytes: readNumber(row['size_bytes']),
					connectionsTotal: readNumber(row['connections_total']),
					maxConnections: readNumber(row['max_connections']),
					memoryBytes: readNumber(row['memory_bytes']),
				}));
			}),
		);
	}

	/**
	 * Roll closed hours of 1-minute data into metrics_1h, replacing earlier rollups of the same
	 * hours. By default only hours that are still *complete* in metrics_1m are recomputed: the
	 * oldest hour is pruned minute by minute, and re-rolling it would overwrite a full hourly row
	 * with a shrinking remainder. An explicit `from` overrides that (backfills, tests).
	 */
	async rollupHourly(from?: TimeInput, to?: TimeInput): Promise<number> {
		return this.#guarded('rollupHourly', 0, async () => {
			const fromMs =
				from === undefined
					? Math.ceil((this.#now() - this.#rawRetentionHours * HOUR_MS) / HOUR_MS) * HOUR_MS
					: toEpochMs(from);
			const toMs = to === undefined ? this.#now() : toEpochMs(to);
			if (toMs <= fromMs) return 0;

			return this.#serialize(async () => {
				const connection = this.#requireWriteConnection();
				const params = [isoFromMs(fromMs), isoFromMs(toMs)];
				await connection.run('BEGIN TRANSACTION');
				try {
					await connection.run(ROLLUP_CREATE_SQL, [...params, ...params, ...params]);
					const countResult = await connection.runAndReadAll(
						`SELECT count(*) AS n FROM ${ROLLUP_TABLE}`,
					);
					const rolled = readNumber(countResult.getRowObjectsJson()[0]?.['n']);
					if (rolled > 0) {
						await connection.run(ROLLUP_DELETE_SQL, params);
						await connection.run(ROLLUP_INSERT_SQL);
					}
					// Managed databases roll up over the same window (D57).
					await connection.run(DB_ROLLUP_DELETE_SQL, params);
					await connection.run(DB_ROLLUP_INSERT_SQL, params);
					// Managed object storage too (S7).
					await connection.run(ST_ROLLUP_DELETE_SQL, params);
					await connection.run(ST_ROLLUP_INSERT_SQL, params);
					await connection.run('COMMIT');
					return rolled;
				} catch (error) {
					try {
						await connection.run('ROLLBACK');
					} catch {
						// Already rolled back or the connection is gone.
					}
					throw error;
				} finally {
					try {
						await connection.run(`DROP TABLE IF EXISTS ${ROLLUP_TABLE}`);
					} catch {
						// A temp table that cannot be dropped will be replaced next time.
					}
				}
			});
		});
	}

	async prune(options: PruneOptions = {}): Promise<{ raw: number; hourly: number }> {
		return this.#guarded('prune', { raw: 0, hourly: 0 }, async () => {
			const rawHours = options.rawHours ?? this.#rawRetentionHours;
			const hourlyDays = options.hourlyDays ?? 90;
			if (!Number.isFinite(rawHours) || rawHours < 0)
				throw new Error('rawHours must be a non-negative number');
			if (!Number.isFinite(hourlyDays) || hourlyDays < 0)
				throw new Error('hourlyDays must be a non-negative number');

			const nowMs = this.#now();
			const rawCutoff = isoFromMs(nowMs - rawHours * HOUR_MS);
			const hourlyCutoff = isoFromMs(nowMs - hourlyDays * DAY_MS);

			return this.#serialize(async () => {
				const connection = this.#requireWriteConnection();
				const raw = await connection.run(
					'DELETE FROM metrics_1m WHERE bucket < CAST(? AS TIMESTAMPTZ)',
					[rawCutoff],
				);
				const hourly = await connection.run(
					'DELETE FROM metrics_1h WHERE bucket < CAST(? AS TIMESTAMPTZ)',
					[hourlyCutoff],
				);
				const dbRaw = await connection.run(
					'DELETE FROM db_metrics_1m WHERE bucket < CAST(? AS TIMESTAMPTZ)',
					[rawCutoff],
				);
				const dbHourly = await connection.run(
					'DELETE FROM db_metrics_1h WHERE bucket < CAST(? AS TIMESTAMPTZ)',
					[hourlyCutoff],
				);
				const stRaw = await connection.run(
					'DELETE FROM storage_metrics_1m WHERE bucket < CAST(? AS TIMESTAMPTZ)',
					[rawCutoff],
				);
				const stHourly = await connection.run(
					'DELETE FROM storage_metrics_1h WHERE bucket < CAST(? AS TIMESTAMPTZ)',
					[hourlyCutoff],
				);
				return {
					raw: raw.rowsChanged + dbRaw.rowsChanged + stRaw.rowsChanged,
					hourly: hourly.rowsChanged + dbHourly.rowsChanged + stHourly.rowsChanged,
				};
			});
		});
	}

	async exportParquet(
		options: ParquetExportOptions,
	): Promise<{ files: string[]; bytes: number }> {
		return this.#guarded('exportParquet', { files: [], bytes: 0 }, async () => {
			const fromMs = toEpochMs(options.from);
			const toMs = toEpochMs(options.to);
			if (toMs < fromMs) return { files: [], bytes: 0 };

			await mkdir(options.dir, { recursive: true });
			const target = escapeSqlString(options.dir);
			await this.#withReadConnection(async (connection) => {
				await connection.run(
					`COPY (
						SELECT *, CAST(bucket AS DATE) AS day
						FROM metrics_1m
						WHERE bucket >= CAST(? AS TIMESTAMPTZ) AND bucket < CAST(? AS TIMESTAMPTZ)
					) TO '${target}' (
						FORMAT parquet,
						PARTITION_BY (day),
						COMPRESSION zstd,
						OVERWRITE_OR_IGNORE
					)`,
					[isoFromMs(fromMs), isoFromMs(toMs)],
				);
			});

			const entries = await readdir(options.dir, { recursive: true });
			const files = entries
				.filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.parquet'))
				.map((entry) => join(options.dir, entry))
				.sort();
			if (files.length === 0) return { files: [], bytes: 0 };

			let bytes = 0;
			for (const file of files) bytes += (await stat(file)).size;

			const objectStore = options.objectStore ?? this.#objectStore;
			if (!objectStore) return { files, bytes };

			for (const file of files) {
				const rel = relative(options.dir, file).split(sep).join('/');
				const match = /(?:^|\/)day=(\d{4}-\d{2}-\d{2})\/(.+)$/.exec(rel);
				const key =
					match?.[1] !== undefined && match[2] !== undefined
						? `telemetry/${match[1]}/${match[2]}`
						: `telemetry/${rel}`;
				const data = await readFile(file);
				await objectStore.put(key, new Uint8Array(data), 'application/vnd.apache.parquet');
			}

			await this.#removeExportedFiles(files, options.dir);
			return { files, bytes };
		});
	}

	async getPrometheusMetrics(host?: string): Promise<string> {
		return this.#guarded('getPrometheusMetrics', '', async () => {
			const toMs = this.#now();
			const fromMs = toMs - HOUR_MS;
			const params: string[] = [isoFromMs(fromMs), isoFromMs(toMs)];
			let where = '';
			if (host !== undefined) {
				where = 'AND host = ?';
				params.push(host);
			}

			const rows = await this.#withReadConnection(async (connection) => {
				const result = await connection.runAndReadAll(
					`SELECT host,
						CAST(sum(requests) AS DOUBLE) AS requests,
						CAST(sum(status_5xx) AS DOUBLE) AS errors,
						CAST(sum(bytes) AS DOUBLE) AS bytes
					FROM metrics_1m
					WHERE bucket >= CAST(? AS TIMESTAMPTZ) AND bucket <= CAST(? AS TIMESTAMPTZ)
						${where}
					GROUP BY host
					ORDER BY host ASC`,
					params,
				);
				return result.getRowObjectsJson();
			});

			const lines: string[] = [
				'# HELP skiff_http_requests_total HTTP requests observed in the last hour.',
				'# TYPE skiff_http_requests_total gauge',
			];
			let errors = 0;
			let bytes = 0;
			for (const row of rows) {
				const name = escapePrometheusLabel(readString(row['host']));
				lines.push(
					`skiff_http_requests_total{host="${name}"} ${prometheusNumber(readNumber(row['requests']))}`,
				);
				errors += readNumber(row['errors']);
				bytes += readNumber(row['bytes']);
			}

			lines.push(
				'# HELP skiff_http_errors_total 5xx responses observed in the last hour.',
				'# TYPE skiff_http_errors_total gauge',
			);
			if (rows.length > 0) {
				lines.push(`skiff_http_errors_total{class="5xx"} ${prometheusNumber(errors)}`);
			}

			lines.push(
				'# HELP skiff_bytes_total Response bytes served in the last hour.',
				'# TYPE skiff_bytes_total gauge',
			);
			if (rows.length > 0) {
				lines.push(`skiff_bytes_total ${prometheusNumber(bytes)}`);
			}

			// Managed databases: the newest sample from the last five minutes (D57).
			if (host === undefined) {
				const samples = await this.#withReadConnection(async (connection) => {
					const result = await connection.runAndReadAll(DB_LATEST_SQL, [isoFromMs(toMs - 5 * MINUTE_MS)]);
					return result.getRowObjectsJson();
				});
				const series: Array<[string, string, string]> = [
					['skiff_database_up', 'up', 'Whether the database answered its last sample (1 = up).'],
					['skiff_database_size_bytes', 'size_bytes', 'Database size on disk.'],
					['skiff_database_connections', 'connections_total', 'Open connections.'],
					['skiff_database_max_connections', 'max_connections', 'Configured max_connections.'],
				];
				for (const [name, column, help] of series) {
					lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
					for (const sample of samples) {
						const id = escapePrometheusLabel(readString(sample['database_id']));
						lines.push(`${name}{database_id="${id}"} ${prometheusNumber(readNumber(sample[column]))}`);
					}
				}
			}

			// Managed object storage: the newest sample from the last five minutes (S7).
			if (host === undefined) {
				const samples = await this.#withReadConnection(async (connection) => {
					const result = await connection.runAndReadAll(ST_LATEST_SQL, [isoFromMs(toMs - 5 * MINUTE_MS)]);
					return result.getRowObjectsJson();
				});
				const series: Array<[string, string, string]> = [
					['skiff_storage_up', 'up', 'Whether the storage instance answered its last sample (1 = up).'],
					['skiff_storage_used_bytes', 'used_bytes', 'Bytes stored across buckets.'],
					['skiff_storage_objects', 'objects', 'Objects stored across buckets.'],
					['skiff_storage_buckets', 'bucket_count', 'Buckets on the instance.'],
				];
				for (const [name, column, help] of series) {
					lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
					for (const sample of samples) {
						const id = escapePrometheusLabel(readString(sample['storage_id']));
						lines.push(`${name}{storage_id="${id}"} ${prometheusNumber(readNumber(sample[column]))}`);
					}
				}
			}

			return `${lines.join('\n')}\n`;
		});
	}

	async #doOpen(): Promise<void> {
		let instance: DuckDBInstance | undefined;
		try {
			const duckdb = await this.#loadDuckDb();
			if (this.#path !== ':memory:') await mkdir(dirname(this.#path), { recursive: true });
			instance = await duckdb.DuckDBInstance.create(this.#path, {
				memory_limit: `${this.#memoryLimitMb}MB`,
				threads: String(this.#threads),
			});
			const connection = await instance.connect();
			await connection.run(metricsTableSql('metrics_1m'));
			await connection.run(metricsTableSql('metrics_1h'));
			await connection.run(dbMetricsTableSql('db_metrics_1m'));
			await connection.run(dbMetricsTableSql('db_metrics_1h'));
			await connection.run(storageMetricsTableSql('storage_metrics_1m'));
			await connection.run(storageMetricsTableSql('storage_metrics_1h'));
			this.#instance = instance;
			this.#connection = connection;
			this.error = null;
			this.available = true;
		} catch (error) {
			try {
				instance?.closeSync();
			} catch {
				// The open error is the one worth keeping.
			}
			const cause = asError(error);
			this.error = new Error(`Telemetry (DuckDB) unavailable: ${cause.message}`, { cause });
			this.available = false;
			this.#notify(this.error);
		}
	}

	async #guarded<T>(operation: string, fallback: T, fn: () => Promise<T>): Promise<T> {
		if (this.#closed) return fallback;
		await this.open();
		if (!this.available) return fallback;
		try {
			return await fn();
		} catch (error) {
			this.#report(operation, error);
			return fallback;
		}
	}

	#serialize<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.#writeTail.then(fn, fn);
		this.#writeTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	#requireWriteConnection(): DuckDBConnection {
		if (!this.#connection) throw new Error('Telemetry store is not open');
		return this.#connection;
	}

	async #withReadConnection<T>(fn: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
		const instance = this.#instance;
		if (!instance) throw new Error('Telemetry store is not open');
		const connection = await instance.connect();
		try {
			return await fn(connection);
		} finally {
			connection.closeSync();
		}
	}

	async #removeExportedFiles(files: string[], base: string): Promise<void> {
		const dirs = new Set<string>();
		for (const file of files) {
			await rm(file, { force: true });
			dirs.add(dirname(file));
		}
		for (const dir of dirs) {
			if (dir !== base && !dir.startsWith(base + sep)) continue;
			try {
				await rmdir(dir);
			} catch {
				// Not empty (or already removed); only empty partitions are cleaned.
			}
		}
		try {
			await rmdir(base);
		} catch {
			// The caller may have other files in the directory.
		}
	}

	#report(operation: string, cause: unknown): void {
		const error = asError(cause);
		const wrapped = new Error(`Telemetry ${operation} failed: ${error.message}`, { cause: error });
		this.error = wrapped;
		this.#notify(wrapped);
	}

	#notify(error: Error): void {
		try {
			this.#onError?.(error);
		} catch {
			// Error reporting must never take the caller down either.
		}
	}
}

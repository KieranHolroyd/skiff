import type {
	AnalyticsEvent,
	BrokerMetricBucket,
	BrokerMetricPoint,
	DatabaseMetricBucket,
	DatabaseMetricPoint,
	FunctionTailEvent,
	MetricBucket,
	StorageMetricBucket,
	StorageMetricPoint,
} from '@skiff/contracts';
import { mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import {
	ClickHouseClient,
	ClickHouseError,
	ClickHouseUnavailableError,
	type ClickHouseCompactResult,
	type ClickHouseConfig,
	type ClickHouseParams,
	type ClickHouseSettings,
} from './clickhouse.ts';
import {
	MQ_COUNTERS,
	MQ_GAUGES,
	brokerCountersSql,
	brokerGaugeAggregate,
	brokerLatestSql,
	brokerMetricsTableSql,
	brokerRollupSql,
	brokerSeriesSql,
} from './broker-metrics-sql.ts';
import {
	DB_COUNTERS,
	DB_GAUGES,
	DB_MAX_GAUGES,
	dbLatestSql,
	dbMetricsTableSql,
	dbRollupSql,
	dbSeriesSql,
} from './database-metrics-sql.ts';
import type { ObjectStore } from './object-store.ts';
import {
	ST_GAUGES,
	ST_MAX_GAUGES,
	storageLatestSql,
	storageMetricsTableSql,
	storageRollupSql,
	storageSeriesSql,
} from './storage-metrics-sql.ts';

/**
 * Telemetry hot store (DESIGN §8, D15, D16, D101). Agents send pre-aggregated 1-minute buckets;
 * a local ClickHouse server keeps 48 h of them, the store rolls them into hourly rows kept for
 * 90 days and archives day-partitioned Parquet to the object store.
 *
 * Tables are ReplacingMergeTree keyed by (series, bucket) with an ingest `version`: re-sending a
 * minute replaces it, and every read runs with `final = 1` so it sees one row per key.
 *
 * Every public method is fail-open: telemetry is an observability aid, so an unreachable
 * ClickHouse must never stop the control plane booting or a deploy from completing. Failures are
 * reported through the injected `onError`, and an unreachable server is retried after
 * `openRetryMs`.
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
 * Everything one dashboard needs from the store in one call: totals, a gap-filled time series,
 * per-host/per-project breakdowns and the busiest paths/referrers.
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
	poolerUp: boolean;
	poolActive: number;
	poolIdle: number;
	poolWaiting: number;
	poolSaturation: number;
	poolAvgWaitMs: number;
}

export interface StorageMetricsQuery {
	storageId: string;
	from: TimeInput;
	to: TimeInput;
	interval: TelemetryInterval;
}

export interface BrokerMetricsQuery {
	brokerId: string;
	from: TimeInput;
	to: TimeInput;
	interval: TelemetryInterval;
}

/** Last-hour traffic for one project (`scrapeSamples`). */
export interface ScrapeTrafficRow {
	projectId: string;
	requests: number;
	status2xx: number;
	status3xx: number;
	status4xx: number;
	status5xx: number;
	bytes: number;
	/** Request-weighted mean of the minute medians / p95s. */
	durationP50Ms: number;
	durationP95Ms: number;
}

/** A database or storage row keyed by id, with ClickHouse column names as value keys. */
export interface ScrapeSampleRow {
	id: string;
	values: Record<string, number>;
}

export interface ScrapeSamples {
	traffic: ScrapeTrafficRow[];
	/** Newest sample per database (`dbLatestSql` columns). */
	databases: ScrapeSampleRow[];
	/** Last-hour sums of the `DB_COUNTERS` columns per database. */
	databaseCounters: ScrapeSampleRow[];
	/** Newest sample per storage instance (`storageLatestSql` columns). */
	storage: ScrapeSampleRow[];
	/** Newest sample per broker (`brokerLatestSql` columns). */
	brokers: ScrapeSampleRow[];
	/** Last-hour sums of the `MQ_COUNTERS` columns per broker. */
	brokerCounters: ScrapeSampleRow[];
}

export interface FunctionInvocationQuery {
	projectId: string;
	from: TimeInput;
	to: TimeInput;
	/** 1–200, default 50. */
	limit?: number;
	/** Epoch ms: only items strictly older, for paging backwards. */
	before?: number;
	outcome?: string;
}

/** One tail-worker item as the console shows it; request carries no headers, cookies or bodies. */
export interface FunctionInvocationRow {
	at: string;
	workloadId: string;
	scriptName: string;
	outcome: string;
	logs: Array<{ level: string; message: string }>;
	exceptions: Array<{ name: string; message: string }>;
	request: { method: string; url: string; status?: number } | null;
}

export interface FunctionInvocationSummary {
	total: number;
	byOutcome: Record<string, number>;
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
	/** Local output directory. The store writes `day=YYYY-MM-DD/data_0.parquet` below it. */
	dir: string;
	/** Overrides the store-level object store. Local files are deleted after upload. */
	objectStore?: ObjectStore;
}

export interface TelemetryOptions {
	/**
	 * The ClickHouse server, as the writer user (it creates the database and tables). Absent: the
	 * store stays unavailable and reports why.
	 */
	clickhouse?: ClickHouseConfig;
	/**
	 * The read-only user that runs ad-hoc dashboard SQL (D101). Absent: ad-hoc SQL runs as the
	 * writer with `readonly = 2` and the same limits.
	 */
	reader?: { user: string; password: string };
	/** 1-minute retention in hours (default 48). Rollups only rewrite hours fully inside it. */
	rawRetentionHours?: number;
	/** 1-hour retention in days (default 90). */
	hourlyRetentionDays?: number;
	/**
	 * Table TTLs as a backstop to `prune()` (default on, a day past each retention). Tests turn
	 * them off: their fixed clock writes rows that the real clock would already expire.
	 */
	tableTtl?: boolean;
	objectStore?: ObjectStore;
	/** Called for every swallowed telemetry failure. */
	onError?: (error: Error) => void;
	/** Injected clock (tests and deterministic rollups). */
	now?: () => number;
	/** Never connect; report this reason instead. */
	disabledReason?: string;
	/** How long a failed open waits before the next operation retries it (default 30 s). */
	openRetryMs?: number;
}

/** Limits for ad-hoc SQL, whoever runs it (the reader profile enforces the same caps). */
export const AD_HOC_LIMITS: ClickHouseSettings = {
	max_execution_time: 30,
	max_result_rows: 20_000,
	result_overflow_mode: 'break',
	max_memory_usage: 268_435_456,
	max_threads: 2,
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TOP_N = 10;

/** Settings for every read of the replacing tables. */
const READ_SETTINGS: ClickHouseSettings = {
	final: 1,
	do_not_merge_across_partitions_select_final: 1,
	// `sum(requests) AS requests` must not turn a later `sum(x * requests)` into a nested aggregate.
	prefer_column_name_to_alias: 1,
};

const TRAFFIC_COLUMNS = [
	'host',
	'project_id',
	'bucket',
	'requests',
	'status_2xx',
	'status_3xx',
	'status_4xx',
	'status_5xx',
	'bytes',
	'duration_p50_ms',
	'duration_p95_ms',
	'top_paths',
	'top_referrers',
] as const;

const trafficTableSql = (database: string, table: string, ttl: string, partition: string): string => `
	CREATE TABLE IF NOT EXISTS ${database}.${table} (
		host LowCardinality(String) COMMENT 'Request host',
		project_id LowCardinality(Nullable(String)) COMMENT 'Project serving the host (prj_...), null for platform hosts',
		bucket DateTime('UTC') COMMENT 'Bucket start (UTC)',
		requests UInt64 COMMENT 'Requests in the bucket',
		status_2xx UInt64,
		status_3xx UInt64,
		status_4xx UInt64,
		status_5xx UInt64,
		bytes UInt64 COMMENT 'Response bytes',
		duration_p50_ms Float64 COMMENT 'Median latency (hourly: request-weighted mean of minute p50s)',
		duration_p95_ms Float64 COMMENT 'p95 latency (hourly: request-weighted mean of minute p95s)',
		top_paths Map(String, UInt64) COMMENT 'Busiest paths and their request counts (top 10)',
		top_referrers Map(String, UInt64) COMMENT 'Top referrers and their request counts (top 10)',
		version UInt64 COMMENT 'Ingest time (ms); the newest row per key wins'
	) ENGINE = ReplacingMergeTree(version)
	PARTITION BY ${partition}
	ORDER BY (host, bucket)
	TTL bucket + ${ttl}
	COMMENT 'HTTP traffic per host, pre-aggregated by the edge agents'`;

/**
 * Analytics Engine datapoints written by function bindings (docs/FUNCTIONS.md §4.5, D101).
 *
 * Plain MergeTree, not ReplacingMergeTree: every `writeDataPoint` is a distinct event, so there is
 * no series+bucket key to replace. `ts` keeps millisecond precision (the worker's write time as
 * stamped by the node) and the 90-day TTL is independent of the traffic retention settings.
 */
const analyticsTableSql = (database: string): string => `
	CREATE TABLE IF NOT EXISTS ${database}.function_analytics (
		ts DateTime64(3) COMMENT 'Datapoint time (UTC, milliseconds)',
		project_id LowCardinality(String) COMMENT 'Owning project (prj_...), stamped by the node',
		workload_id String COMMENT 'Owning workload (wl_...), stamped by the node',
		dataset LowCardinality(String) COMMENT 'Analytics Engine dataset name',
		blobs Array(String) COMMENT 'Up to 20 blob values (16 KiB each)',
		doubles Array(Float64) COMMENT 'Up to 20 numeric values',
		indexes Array(String) COMMENT 'Up to 20 index values (1 KiB each)'
	) ENGINE = MergeTree
	ORDER BY (project_id, dataset, ts)
	TTL toDateTime(ts) + INTERVAL 90 DAY
	COMMENT 'Analytics Engine datapoints written by function bindings'`;

/** Rows per INSERT: ClickHouse's HTTP interface is happiest with bounded JSONEachRow bodies. */
const ANALYTICS_INSERT_BATCH = 5_000;
/** Hard per-call cap so one malformed telemetry batch cannot pin an unbounded amount of memory. */
const ANALYTICS_MAX_EVENTS = 50_000;

/**
 * Tail-worker items from function invocations (docs/FUNCTIONS.md §4.5, phase 3).
 *
 * One row per delivered TailItem, with the structured parts stored as JSON strings: the payload is
 * for the log viewer, not for ClickHouse aggregates, and keeping it opaque keeps the schema stable
 * as the tail item grows. The 30-day TTL matches the other function telemetry tables' intent
 * (raw invocation detail is short-lived) and is independent of the traffic retention settings.
 */
const tailEventsTableSql = (database: string): string => `
	CREATE TABLE IF NOT EXISTS ${database}.function_tail_events (
		ts DateTime64(3) COMMENT 'Tail item time (UTC, milliseconds)',
		project_id LowCardinality(String) COMMENT 'Owning project (prj_...), stamped by the node',
		workload_id String COMMENT 'Owning workload (wl_...), stamped by the node',
		script_name String COMMENT 'Script name reported by workerd',
		outcome LowCardinality(String) COMMENT 'Invocation outcome (ok, exception, ...)',
		logs_json String COMMENT 'JSON array of {level, message} log entries',
		exceptions_json String COMMENT 'JSON array of {name, message} exceptions',
		request_json String COMMENT 'JSON {method, url, status?}; never headers, cookies or bodies'
	) ENGINE = MergeTree
	ORDER BY (project_id, ts)
	TTL toDateTime(ts) + INTERVAL 30 DAY
	COMMENT 'Structured tail-worker items from function invocations'`;

/** The contract caps one telemetry batch at 2,000 tails; insert in chunks of that size. */
const TAILS_INSERT_BATCH = 2_000;
/** Hard per-call cap, for the same reason as `ANALYTICS_MAX_EVENTS`. */
const TAILS_MAX_EVENTS = 20_000;

/** Merge a summed map down to its `TOP_N` largest entries. */
const topMap = (expression: string): string =>
	`mapFromArrays(
		arrayMap(x -> x.1, arraySlice(arrayReverseSort(x -> x.2, arrayZip(mapKeys(${expression}), mapValues(${expression}))), 1, ${TOP_N})),
		arrayMap(x -> x.2, arraySlice(arrayReverseSort(x -> x.2, arrayZip(mapKeys(${expression}), mapValues(${expression}))), 1, ${TOP_N}))
	)`;

const weighted = (column: string): string => `if(sum(requests) = 0, 0, sum(${column} * requests) / sum(requests))`;

const trafficRollupSql = (database: string): string => `
	INSERT INTO ${database}.traffic_1h (${TRAFFIC_COLUMNS.join(', ')}, version)
	SELECT host, project_id, hour, requests, status_2xx, status_3xx, status_4xx, status_5xx, bytes,
		duration_p50_ms, duration_p95_ms, ${topMap('paths')}, ${topMap('referrers')}, {version:UInt64}
	FROM (
		SELECT host, argMax(project_id, bucket) AS project_id, toStartOfHour(bucket) AS hour,
			sum(requests) AS requests, sum(status_2xx) AS status_2xx, sum(status_3xx) AS status_3xx,
			sum(status_4xx) AS status_4xx, sum(status_5xx) AS status_5xx, sum(bytes) AS bytes,
			${weighted('duration_p50_ms')} AS duration_p50_ms,
			${weighted('duration_p95_ms')} AS duration_p95_ms,
			sumMap(top_paths) AS paths, sumMap(top_referrers) AS referrers
		FROM ${database}.traffic_1m
		WHERE bucket >= {from:DateTime('UTC')} AND bucket < toStartOfHour({to:DateTime('UTC')})
		GROUP BY host, hour
	)`;

/**
 * Hourly views for SQL users: rolled-up hours plus live minutes for hours not rolled yet. Inner
 * aggregates get `a_` aliases so an alias never shadows the column another aggregate reads (the
 * view runs with the caller's settings, not ours).
 */
const hourlyViewSql = (
	database: string,
	view: string,
	family: string,
	key: string,
	aggregates: ReadonlyArray<readonly [column: string, expression: string]>,
): string => `
	CREATE OR REPLACE VIEW ${database}.${view} AS
	SELECT ${key}, bucket, ${aggregates.map(([column]) => column).join(', ')} FROM ${database}.${family}_1h FINAL
	UNION ALL
	SELECT ${key}, hour AS bucket, ${aggregates.map(([column]) => `a_${column} AS ${column}`).join(', ')}
	FROM (
		SELECT ${key}, toStartOfHour(bucket) AS hour, ${aggregates.map(([column, expression]) => `${expression} AS a_${column}`).join(', ')}
		FROM ${database}.${family}_1m FINAL
		WHERE (${key}, toStartOfHour(bucket)) NOT IN (SELECT ${key}, bucket FROM ${database}.${family}_1h FINAL)
		GROUP BY ${key}, hour
	)`;

interface TotalsAccumulator extends TrafficTotals {
	p50Weighted: number;
	p95Weighted: number;
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

/** `DateTime('UTC')` text for query parameters (second precision, floored). */
export function chDateTime(ms: number): string {
	return new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/** `DateTime64(3)` text with millisecond precision (`date_time_input_format=best_effort`). */
export function chDateTime64(ms: number): string {
	return new Date(ms).toISOString().slice(0, 23).replace('T', ' ');
}

function floorToMinute(ms: number): number {
	return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** Counts are UInt64: clamp nonsense rather than failing a whole batch. */
function toCount(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
	return Math.trunc(value);
}

function toDouble(value: number | undefined): number {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Analytics doubles are signed (deltas, temperatures): only non-finite values are coerced. */
function toAnalyticsDouble(value: number): number {
	return Number.isFinite(value) ? value : 0;
}

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

function parseJsonArray<T>(value: unknown): T[] {
	try {
		const parsed: unknown = JSON.parse(readString(value) || '[]');
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch {
		return [];
	}
}

function parseJsonObject<T>(value: unknown): T | null {
	try {
		const parsed: unknown = JSON.parse(readString(value) || 'null');
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
	} catch {
		return null;
	}
}

function countMap(entries: ReadonlyArray<{ count: number } & Record<string, unknown>> | undefined, key: string): Record<string, number> {
	const map: Record<string, number> = {};
	for (const entry of entries ?? []) {
		const name = entry[key];
		if (typeof name !== 'string') continue;
		map[name] = (map[name] ?? 0) + toCount(entry.count);
	}
	return map;
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

function emptyTotals(): TrafficTotals {
	return { requests: 0, bytes: 0, status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0, durationP50Ms: 0, durationP95Ms: 0 };
}

export function emptyTrafficReport(): TrafficReport {
	return { totals: emptyTotals(), series: [], hosts: [], projects: [], topPaths: [], topReferrers: [] };
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

function upsertAccumulator(map: Map<string | number, TotalsAccumulator>, key: string | number, point: TrafficTotals): void {
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
function fillSeries(map: Map<string | number, TotalsAccumulator>, fromMs: number, toMs: number, step: number): TrafficSeriesPoint[] {
	const start = Math.floor(fromMs / step) * step;
	const end = Math.floor(toMs / step) * step;
	if (end < start) return [];
	const count = Math.floor((end - start) / step) + 1;
	// A pathological range must not allocate millions of points for a dashboard.
	if (count > 20_000) {
		return [...map.entries()]
			.sort(([a], [b]) => Number(a) - Number(b))
			.map(([bucketMs, acc]) => ({ bucket: isoFromMs(Number(bucketMs)), ...finishTotals(acc) }));
	}
	const series: TrafficSeriesPoint[] = [];
	for (let index = 0; index < count; index++) {
		const bucketMs = start + index * step;
		series.push({ bucket: isoFromMs(bucketMs), ...finishTotals(map.get(bucketMs) ?? emptyAccumulator()) });
	}
	return series;
}

/** One ClickHouse row as `{ id, values }`, every non-id column read as a number. */
function numericRow(row: Record<string, unknown>, idColumn: string): ScrapeSampleRow {
	const values: Record<string, number> = {};
	for (const [key, value] of Object.entries(row)) if (key !== idColumn) values[key] = readNumber(value);
	return { id: readString(row[idColumn]), values };
}

function escapePrometheusLabel(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function prometheusNumber(value: number): string {
	return Number.isFinite(value) ? String(value) : '0';
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface TelemetryTable {
	name: string;
	engine: string;
	rows: number;
	bytes: number;
	comment: string;
	columns: Array<{ name: string; type: string; comment: string }>;
}

export interface TelemetryStats {
	version: string;
	uptimeSeconds: number;
	bytesOnDisk: number;
	rows: number;
	/** Memory ClickHouse is tracking right now. */
	memoryBytes: number;
}

/** Shown wherever telemetry would appear on a host without the optional store. */
export const TELEMETRY_NOT_INSTALLED =
	'The telemetry store (ClickHouse) is not installed. A platform owner can install it from Settings → Telemetry.';

export interface AdHocQueryOptions {
	params?: ClickHouseParams;
	settings?: ClickHouseSettings;
	signal?: AbortSignal;
}

export class TelemetryStore {
	readonly #rawRetentionHours: number;
	readonly #hourlyRetentionDays: number;
	readonly #tableTtl: boolean;
	readonly #objectStore: ObjectStore | undefined;
	readonly #onError: ((error: Error) => void) | undefined;
	readonly #now: () => number;
	readonly #disabledReason: string | undefined;
	readonly #openRetryMs: number;
	readonly #client: ClickHouseClient | undefined;
	readonly #reader: ClickHouseClient | undefined;
	/** The database every table lives in. */
	readonly database: string;

	#openPromise: Promise<void> | undefined;
	/** After a failed open, the earliest time another open is attempted. */
	#retryOpenAt = 0;
	#writeTail: Promise<void> = Promise.resolve();
	#closed = false;
	#lastVersion = 0;

	/** True once ClickHouse answered and the schema was created. */
	available = false;
	/** The open error, or the most recent swallowed operation error. */
	error: Error | null = null;

	constructor(options: TelemetryOptions) {
		this.#rawRetentionHours = options.rawRetentionHours ?? 48;
		this.#hourlyRetentionDays = options.hourlyRetentionDays ?? 90;
		this.#tableTtl = options.tableTtl ?? true;
		this.#objectStore = options.objectStore;
		this.#onError = options.onError;
		this.#now = options.now ?? Date.now;
		this.#openRetryMs = options.openRetryMs ?? 30_000;
		this.database = options.clickhouse?.database ?? 'skiff';
		if (!IDENTIFIER.test(this.database)) throw new Error(`Invalid ClickHouse database name: ${this.database}`);
		this.#disabledReason = options.disabledReason ?? (options.clickhouse ? undefined : TELEMETRY_NOT_INSTALLED);
		if (options.clickhouse) {
			// Unqualified names in our SQL never rely on a default database; the database may not exist yet.
			this.#client = new ClickHouseClient({ ...options.clickhouse, database: undefined });
			if (options.reader) this.#reader = this.#client.with({ ...options.reader, database: this.database });
		}
		if (this.#disabledReason)
			this.error = new Error(options.clickhouse ? `Telemetry (ClickHouse) unavailable: ${this.#disabledReason}` : this.#disabledReason);
	}

	/**
	 * The optional telemetry store is installed here (D101): a ClickHouse connection is configured.
	 * False means "not installed", which is a normal state, not an error.
	 */
	get installed(): boolean {
		return this.#client !== undefined;
	}

	/** Whether daily Parquet partitions can be archived (an object store is configured). */
	get archiveEnabled(): boolean {
		return this.#objectStore !== undefined;
	}

	get retention(): { minuteHours: number; hourDays: number } {
		return { minuteHours: this.#rawRetentionHours, hourDays: this.#hourlyRetentionDays };
	}

	/**
	 * Connect and create the schema. A failure leaves the store in no-op mode until the retry
	 * window passes, so a ClickHouse that starts after the control plane (or restarts) heals
	 * itself instead of disabling telemetry until the next restart.
	 */
	async open(): Promise<void> {
		if (this.#closed || this.#disabledReason) return;
		if (this.available) return;
		if (this.#openPromise) return this.#openPromise;
		if (this.#now() < this.#retryOpenAt) return;
		const attempt = this.#doOpen();
		this.#openPromise = attempt;
		await attempt;
		if (this.#openPromise === attempt) this.#openPromise = undefined;
		if (!this.available) this.#retryOpenAt = this.#now() + this.#openRetryMs;
	}

	/** Open if needed and say whether the store is usable now. */
	async ready(): Promise<boolean> {
		await this.open();
		return this.available;
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.available = false;
		await this.#writeTail;
	}

	/** Drop the whole telemetry database (tests and resets only). */
	async dropDatabase(): Promise<void> {
		if (!this.#client) return;
		await this.#client.exec(`DROP DATABASE IF EXISTS ${this.database} SYNC`);
	}

	async ingest(buckets: MetricBucket[]): Promise<{ inserted: number }> {
		return this.#guarded('ingest', { inserted: 0 }, async () => {
			const rows = new Map<string, Record<string, unknown>>();
			for (const bucket of buckets) {
				const bucketMs = floorToMinute(toEpochMs(bucket.bucket));
				rows.set(`${bucket.host}\u0000${bucketMs}`, {
					host: bucket.host,
					project_id: bucket.projectId ?? null,
					bucket: chDateTime(bucketMs),
					requests: toCount(bucket.requests),
					status_2xx: toCount(bucket.status2xx),
					status_3xx: toCount(bucket.status3xx),
					status_4xx: toCount(bucket.status4xx),
					status_5xx: toCount(bucket.status5xx),
					bytes: toCount(bucket.bytes),
					duration_p50_ms: toDouble(bucket.durationP50Ms),
					duration_p95_ms: toDouble(bucket.durationP95Ms),
					top_paths: countMap(bucket.topPaths, 'path'),
					top_referrers: countMap(bucket.topReferrers, 'referrer'),
				});
			}
			if (rows.size === 0) return { inserted: 0 };
			return this.#serialize(async () => {
				const version = this.#nextVersion();
				const values = [...rows.values()].map((row) => ({ ...row, version }));
				await this.#write().insert(`${this.database}.traffic_1m`, values);
				return { inserted: values.length };
			});
		});
	}

	async query(input: TelemetryQuery): Promise<MetricPoint[]> {
		return this.#guarded('query', [], async () => {
			const fromMs = toEpochMs(input.from);
			const toMs = toEpochMs(input.to);
			if (toMs < fromMs) return [];
			const unit = input.interval === '1h' ? 'HOUR' : 'MINUTE';
			const source = this.#sourceFor(input);
			const sql = `
				SELECT toUnixTimestamp(toStartOfInterval(bucket, INTERVAL 1 ${unit})) * 1000 AS bucket_ms,
					host, project_id,
					toFloat64(sum(requests)) AS requests,
					toFloat64(sum(status_2xx)) AS status_2xx,
					toFloat64(sum(status_3xx)) AS status_3xx,
					toFloat64(sum(status_4xx)) AS status_4xx,
					toFloat64(sum(status_5xx)) AS status_5xx,
					toFloat64(sum(bytes)) AS bytes,
					${weighted('duration_p50_ms')} AS duration_p50_ms,
					${weighted('duration_p95_ms')} AS duration_p95_ms
				FROM ${source.sql} AS src
				GROUP BY bucket_ms, host, project_id
				ORDER BY bucket_ms ASC, host ASC, project_id ASC`;
			const rows = await this.#read(sql, source.params);
			return rows.map((row) => toMetricPoint(row));
		});
	}

	/**
	 * Dashboard projection of the same hot store. Totals, series, host/project breakdowns and
	 * top paths/referrers come from three reads instead of one per card.
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
				upsertAccumulator(byBucket, Math.floor(toEpochMs(point.bucket) / step) * step, point);
				upsertAccumulator(byHost, point.host, point);
				if (point.projectId) upsertAccumulator(byProject, point.projectId, point);
			}

			const topLimit = Math.min(Math.max(input.topLimit ?? 10, 1), 100);
			const [paths, referrers] = await Promise.all([
				this.#topEntries(input, 'top_paths', topLimit),
				this.#topEntries(input, 'top_referrers', topLimit),
			]);

			return {
				totals: finishTotals(totals),
				series: fillSeries(byBucket, fromMs, toMs, step),
				hosts: finishBreakdown(byHost),
				projects: finishBreakdown(byProject),
				topPaths: paths,
				topReferrers: referrers,
			};
		});
	}

	/** Shared `traffic_1h ∪ traffic_1m` source for dashboard queries, with filters applied. */
	#sourceFor(input: TelemetryQuery): { sql: string; params: ClickHouseParams } {
		const params: ClickHouseParams = {
			from: chDateTime(toEpochMs(input.from)),
			to: chDateTime(toEpochMs(input.to)),
		};
		const filters: string[] = [];
		if (input.host !== undefined) {
			filters.push('host = {host:String}');
			params.host = input.host;
		}
		if (input.projectId !== undefined) {
			filters.push('project_id = {projectId:String}');
			params.projectId = input.projectId;
		}
		if (input.projectIds !== undefined) {
			if (input.projectIds.length === 0) filters.push('0');
			else {
				filters.push('project_id IN {projectIds:Array(String)}');
				params.projectIds = input.projectIds;
			}
		}
		const where = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';
		const columns = TRAFFIC_COLUMNS.join(', ');
		const db = this.database;

		// Hourly queries read traffic_1h wherever an hour has been rolled up (1-minute rows are
		// pruned after 48 h) and fall back to 1-minute rows for hours not rolled yet, such as the
		// current one. Minute queries only have 1-minute data to read.
		if (input.interval === '1h') {
			return {
				sql: `(
					SELECT ${columns} FROM ${db}.traffic_1h
					WHERE bucket >= toStartOfHour({from:DateTime('UTC')}) AND bucket <= {to:DateTime('UTC')} ${where}
					UNION ALL
					SELECT ${columns} FROM ${db}.traffic_1m
					WHERE bucket >= {from:DateTime('UTC')} AND bucket <= {to:DateTime('UTC')} ${where}
						AND (host, toStartOfHour(bucket)) NOT IN (
							SELECT host, bucket FROM ${db}.traffic_1h
							WHERE bucket >= toStartOfHour({from:DateTime('UTC')}) AND bucket <= {to:DateTime('UTC')}
						)
				)`,
				params,
			};
		}
		return {
			sql: `(
				SELECT ${columns} FROM ${db}.traffic_1m
				WHERE bucket >= {from:DateTime('UTC')} AND bucket <= {to:DateTime('UTC')} ${where}
			)`,
			params,
		};
	}

	async #topEntries(input: TelemetryQuery, column: 'top_paths' | 'top_referrers', limit: number): Promise<TrafficTopEntry[]> {
		const source = this.#sourceFor(input);
		const rows = await this.#read(
			`SELECT k AS key, toFloat64(sum(v)) AS count
			FROM ${source.sql} AS src
			ARRAY JOIN mapKeys(${column}) AS k, mapValues(${column}) AS v
			GROUP BY key
			ORDER BY count DESC, key ASC
			LIMIT {limit:UInt32}`,
			{ ...source.params, limit },
		);
		return rows.map((row) => ({ key: readString(row['key']), count: readNumber(row['count']) }));
	}

	/** Managed-database minute samples (D57). Re-sending a minute replaces it. */
	async ingestDatabaseMetrics(buckets: DatabaseMetricBucket[]): Promise<{ inserted: number }> {
		return this.#guarded('ingestDatabaseMetrics', { inserted: 0 }, async () => {
			const rows = new Map<string, Record<string, unknown>>();
			for (const bucket of buckets) {
				const bucketMs = floorToMinute(toEpochMs(bucket.bucket));
				const row: Record<string, unknown> = { database_id: bucket.databaseId, bucket: chDateTime(bucketMs) };
				for (const [column, key] of DB_GAUGES) row[column] = key === 'up' ? (bucket.up ? 1 : 0) : toDouble(bucket[key]);
				for (const [column, key] of DB_COUNTERS) row[column] = toCount(bucket[key]);
				rows.set(`${bucket.databaseId}\u0000${bucketMs}`, row);
			}
			if (rows.size === 0) return { inserted: 0 };
			return this.#serialize(async () => {
				const version = this.#nextVersion();
				const values = [...rows.values()].map((row) => ({ ...row, version }));
				await this.#write().insert(`${this.database}.db_metrics_1m`, values);
				return { inserted: values.length };
			});
		});
	}

	async queryDatabaseMetrics(input: DatabaseMetricsQuery): Promise<DatabaseMetricPoint[]> {
		return this.#guarded('queryDatabaseMetrics', [], async () => {
			const fromMs = toEpochMs(input.from);
			const toMs = toEpochMs(input.to);
			if (toMs < fromMs) return [];
			const rows = await this.#read(dbSeriesSql(this.database, input.interval), {
				id: input.databaseId,
				from: chDateTime(fromMs),
				to: chDateTime(toMs),
			});
			return rows.map((row) => {
				const point = { bucket: isoFromMs(readNumber(row['bucket_ms'])) } as Record<string, unknown>;
				for (const [column, key] of [...DB_GAUGES, ...DB_COUNTERS]) point[key] = readNumber(row[column]);
				return point as unknown as DatabaseMetricPoint;
			});
		});
	}

	/** Managed object storage minute samples (S7). Re-sending a minute replaces it. */
	async ingestStorageMetrics(buckets: StorageMetricBucket[]): Promise<{ inserted: number }> {
		return this.#guarded('ingestStorageMetrics', { inserted: 0 }, async () => {
			const rows = new Map<string, Record<string, unknown>>();
			for (const bucket of buckets) {
				const bucketMs = floorToMinute(toEpochMs(bucket.bucket));
				const row: Record<string, unknown> = { storage_id: bucket.storageId, bucket: chDateTime(bucketMs) };
				for (const [column, key] of ST_GAUGES) row[column] = key === 'up' ? (bucket.up ? 1 : 0) : toDouble(bucket[key]);
				rows.set(`${bucket.storageId}\u0000${bucketMs}`, row);
			}
			if (rows.size === 0) return { inserted: 0 };
			return this.#serialize(async () => {
				const version = this.#nextVersion();
				const values = [...rows.values()].map((row) => ({ ...row, version }));
				await this.#write().insert(`${this.database}.storage_metrics_1m`, values);
				return { inserted: values.length };
			});
		});
	}

	async queryStorageMetrics(input: StorageMetricsQuery): Promise<StorageMetricPoint[]> {
		return this.#guarded('queryStorageMetrics', [], async () => {
			const fromMs = toEpochMs(input.from);
			const toMs = toEpochMs(input.to);
			if (toMs < fromMs) return [];
			const rows = await this.#read(storageSeriesSql(this.database, input.interval), {
				id: input.storageId,
				from: chDateTime(fromMs),
				to: chDateTime(toMs),
			});
			return rows.map((row) => {
				const point = { bucket: isoFromMs(readNumber(row['bucket_ms'])) } as Record<string, unknown>;
				for (const [column, key] of ST_GAUGES) point[key] = readNumber(row[column]);
				return point as unknown as StorageMetricPoint;
			});
		});
	}

	/** Managed queue broker minute samples (D123). Re-sending a minute replaces it. */
	async ingestBrokerMetrics(buckets: BrokerMetricBucket[]): Promise<{ inserted: number }> {
		return this.#guarded('ingestBrokerMetrics', { inserted: 0 }, async () => {
			const rows = new Map<string, Record<string, unknown>>();
			for (const bucket of buckets) {
				const bucketMs = floorToMinute(toEpochMs(bucket.bucket));
				const row: Record<string, unknown> = { broker_id: bucket.brokerId, bucket: chDateTime(bucketMs) };
				for (const [column, key] of MQ_GAUGES) row[column] = key === 'up' ? (bucket.up ? 1 : 0) : toDouble(bucket[key]);
				for (const [column, key] of MQ_COUNTERS) row[column] = Math.max(0, Math.trunc(toDouble(bucket[key])));
				rows.set(`${bucket.brokerId}\u0000${bucketMs}`, row);
			}
			if (rows.size === 0) return { inserted: 0 };
			return this.#serialize(async () => {
				const version = this.#nextVersion();
				const values = [...rows.values()].map((row) => ({ ...row, version }));
				await this.#write().insert(`${this.database}.broker_metrics_1m`, values);
				return { inserted: values.length };
			});
		});
	}

	async queryBrokerMetrics(input: BrokerMetricsQuery): Promise<BrokerMetricPoint[]> {
		return this.#guarded('queryBrokerMetrics', [], async () => {
			const fromMs = toEpochMs(input.from);
			const toMs = toEpochMs(input.to);
			if (toMs < fromMs) return [];
			const rows = await this.#read(brokerSeriesSql(this.database, input.interval), {
				id: input.brokerId,
				from: chDateTime(fromMs),
				to: chDateTime(toMs),
			});
			return rows.map((row) => {
				const point = { bucket: isoFromMs(readNumber(row['bucket_ms'])) } as Record<string, unknown>;
				for (const [column, key] of [...MQ_GAUGES, ...MQ_COUNTERS]) point[key] = readNumber(row[column]);
				return point as unknown as BrokerMetricPoint;
			});
		});
	}

	/**
	 * Analytics Engine datapoints written by function bindings (docs/FUNCTIONS.md §4.5, D101).
	 * Insert-only and fail-open like every other method: a ClickHouse outage loses telemetry, never
	 * a deploy or a function request. Rows go in bounded batches; the contract caps a telemetry
	 * batch at 5,000 events, and a larger hand-fed array is still chunked rather than refused.
	 */
	async ingestAnalytics(events: AnalyticsEvent[]): Promise<void> {
		await this.#guarded('ingestAnalytics', undefined, async () => {
			if (events.length === 0) return undefined;
			const rows = events.slice(0, ANALYTICS_MAX_EVENTS).map((event) => ({
				ts: chDateTime64(event.ts),
				project_id: event.projectId,
				workload_id: event.workloadId,
				dataset: event.dataset,
				blobs: [...event.blobs],
				doubles: event.doubles.map(toAnalyticsDouble),
				indexes: [...event.indexes],
			}));
			await this.#serialize(async () => {
				for (let offset = 0; offset < rows.length; offset += ANALYTICS_INSERT_BATCH) {
					await this.#write().insert(
						`${this.database}.function_analytics`,
						rows.slice(offset, offset + ANALYTICS_INSERT_BATCH),
					);
				}
			});
			return undefined;
		});
	}

	/**
	 * Tail-worker items from function invocations (docs/FUNCTIONS.md §4.5, phase 3). Insert-only and
	 * fail-open like every other method. `logs`, `exceptions` and `request` are stored as JSON
	 * strings; a ClickHouse outage loses telemetry, never a function request or a deploy.
	 */
	async ingestTails(events: FunctionTailEvent[]): Promise<void> {
		await this.#guarded('ingestTails', undefined, async () => {
			if (events.length === 0) return undefined;
			const rows = events.slice(0, TAILS_MAX_EVENTS).map((event) => ({
				ts: chDateTime64(event.ts),
				project_id: event.projectId,
				workload_id: event.workloadId,
				script_name: event.scriptName,
				outcome: event.outcome,
				logs_json: JSON.stringify(event.logs),
				exceptions_json: JSON.stringify(event.exceptions),
				request_json: JSON.stringify(event.request),
			}));
			await this.#serialize(async () => {
				for (let offset = 0; offset < rows.length; offset += TAILS_INSERT_BATCH) {
					await this.#write().insert(
						`${this.database}.function_tail_events`,
						rows.slice(offset, offset + TAILS_INSERT_BATCH),
					);
				}
			});
			return undefined;
		});
	}

	/**
	 * Recent tail-worker items for one function, newest first (the console's Invocations view).
	 * `before` pages backwards by timestamp; `outcome` filters to one outcome (`ok`, `exception`…).
	 * Returns [] when telemetry is down, like every read here.
	 */
	async functionInvocations(input: FunctionInvocationQuery): Promise<FunctionInvocationRow[]> {
		return this.#guarded('functionInvocations', [], async () => {
			const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
			const filters = ['project_id = {project:String}', 'ts >= {from:DateTime64(3)}', 'ts <= {to:DateTime64(3)}'];
			const params: ClickHouseParams = {
				project: input.projectId,
				from: chDateTime64(toEpochMs(input.from)),
				to: chDateTime64(toEpochMs(input.to)),
			};
			if (input.before !== undefined) {
				filters.push('ts < {before:DateTime64(3)}');
				params.before = chDateTime64(input.before);
			}
			if (input.outcome) {
				filters.push('outcome = {outcome:String}');
				params.outcome = input.outcome;
			}
			const rows = await this.#read(
				`SELECT toUnixTimestamp64Milli(ts) AS ts_ms, workload_id, script_name, outcome, logs_json,
					exceptions_json, request_json
				FROM ${this.database}.function_tail_events
				WHERE ${filters.join(' AND ')}
				ORDER BY ts DESC
				LIMIT ${limit}`,
				params,
			);
			return rows.map((row) => ({
				at: isoFromMs(readNumber(row['ts_ms'])),
				workloadId: readString(row['workload_id']),
				scriptName: readString(row['script_name']),
				outcome: readString(row['outcome']) || 'unknown',
				logs: parseJsonArray<{ level: string; message: string }>(row['logs_json']),
				exceptions: parseJsonArray<{ name: string; message: string }>(row['exceptions_json']),
				request: parseJsonObject<{ method: string; url: string; status?: number }>(row['request_json']),
			}));
		});
	}

	/** Invocation counts by outcome for one function over a window (the console's headline). */
	async functionInvocationSummary(input: Omit<FunctionInvocationQuery, 'limit' | 'before' | 'outcome'>): Promise<FunctionInvocationSummary> {
		const empty: FunctionInvocationSummary = { total: 0, byOutcome: {} };
		return this.#guarded('functionInvocationSummary', empty, async () => {
			const rows = await this.#read(
				`SELECT outcome, count() AS n
				FROM ${this.database}.function_tail_events
				WHERE project_id = {project:String} AND ts >= {from:DateTime64(3)} AND ts <= {to:DateTime64(3)}
				GROUP BY outcome`,
				{
					project: input.projectId,
					from: chDateTime64(toEpochMs(input.from)),
					to: chDateTime64(toEpochMs(input.to)),
				},
			);
			const byOutcome: Record<string, number> = {};
			let total = 0;
			for (const row of rows) {
				const n = readNumber(row['n']);
				byOutcome[readString(row['outcome']) || 'unknown'] = n;
				total += n;
			}
			return { total, byOutcome };
		});
	}

	/** Newest sample per database since `sinceMs` (alerts and `/metrics`). */
	async latestDatabaseMetrics(sinceMs: number): Promise<DatabaseLatestSample[]> {
		return this.#guarded('latestDatabaseMetrics', [], async () => {
			const rows = await this.#read(dbLatestSql(this.database), { since: chDateTime(sinceMs) });
			return rows.map((row) => ({
				databaseId: readString(row['database_id']),
				up: readNumber(row['up']) >= 0.5,
				sizeBytes: readNumber(row['size_bytes']),
				connectionsTotal: readNumber(row['connections_total']),
				maxConnections: readNumber(row['max_connections']),
				memoryBytes: readNumber(row['memory_bytes']),
				poolerUp: readNumber(row['pooler_up']) >= 0.5,
				poolActive: readNumber(row['pool_active']),
				poolIdle: readNumber(row['pool_idle']),
				poolWaiting: readNumber(row['pool_waiting']),
				poolSaturation: readNumber(row['pool_saturation']),
				poolAvgWaitMs: readNumber(row['pool_avg_wait_ms']),
			}));
		});
	}

	/**
	 * Roll closed hours of 1-minute data into the hourly tables. Inserting a newer version of an
	 * hour replaces the earlier rollup, so repeated rollups are idempotent. By default only hours
	 * that are still *complete* in the minute tables are recomputed: the oldest hour is pruned
	 * minute by minute, and re-rolling it would overwrite a full hourly row with a shrinking
	 * remainder. An explicit `from` overrides that (backfills, tests).
	 */
	async rollupHourly(from?: TimeInput, to?: TimeInput): Promise<number> {
		return this.#guarded('rollupHourly', 0, async () => {
			const fromMs =
				from === undefined ? Math.ceil((this.#now() - this.#rawRetentionHours * HOUR_MS) / HOUR_MS) * HOUR_MS : toEpochMs(from);
			const toMs = to === undefined ? this.#now() : toEpochMs(to);
			if (toMs <= fromMs) return 0;
			return this.#serialize(async () => {
				const client = this.#write();
				const params = { from: chDateTime(fromMs), to: chDateTime(toMs), version: this.#nextVersion() };
				const [countRow] = await client.query<{ n: number }>(
					`SELECT uniqExact(host, toStartOfHour(bucket)) AS n FROM ${this.database}.traffic_1m
					WHERE bucket >= {from:DateTime('UTC')} AND bucket < toStartOfHour({to:DateTime('UTC')})`,
					{ params, settings: READ_SETTINGS },
				);
				const rolled = readNumber(countRow?.n);
				const settings = { ...READ_SETTINGS, insert_deduplicate: 0 };
				if (rolled > 0) await client.exec(trafficRollupSql(this.database), { params, settings });
				// Managed databases, object storage and brokers roll up over the same window (D57, S7, D123).
				await client.exec(dbRollupSql(this.database), { params, settings });
				await client.exec(storageRollupSql(this.database), { params, settings });
				await client.exec(brokerRollupSql(this.database), { params, settings });
				return rolled;
			});
		});
	}

	async prune(options: PruneOptions = {}): Promise<{ raw: number; hourly: number }> {
		return this.#guarded('prune', { raw: 0, hourly: 0 }, async () => {
			const rawHours = options.rawHours ?? this.#rawRetentionHours;
			const hourlyDays = options.hourlyDays ?? this.#hourlyRetentionDays;
			if (!Number.isFinite(rawHours) || rawHours < 0) throw new Error('rawHours must be a non-negative number');
			if (!Number.isFinite(hourlyDays) || hourlyDays < 0) throw new Error('hourlyDays must be a non-negative number');

			const nowMs = this.#now();
			const rawCutoff = chDateTime(nowMs - rawHours * HOUR_MS);
			const hourlyCutoff = chDateTime(nowMs - hourlyDays * DAY_MS);

			return this.#serialize(async () => {
				const client = this.#write();
				const drop = async (table: string, cutoff: string): Promise<number> => {
					const params = { cutoff };
					const [row] = await client.query<{ n: number }>(
						`SELECT count() AS n FROM ${this.database}.${table} WHERE bucket < {cutoff:DateTime('UTC')}`,
						{ params, settings: READ_SETTINGS },
					);
					const count = readNumber(row?.n);
					if (count > 0)
						await client.exec(`DELETE FROM ${this.database}.${table} WHERE bucket < {cutoff:DateTime('UTC')}`, {
							params,
							settings: { lightweight_deletes_sync: 2 },
						});
					return count;
				};
				let raw = 0;
				let hourly = 0;
				for (const family of ['traffic', 'db_metrics', 'storage_metrics', 'broker_metrics']) {
					raw += await drop(`${family}_1m`, rawCutoff);
					hourly += await drop(`${family}_1h`, hourlyCutoff);
				}
				return { raw, hourly };
			});
		});
	}

	/** Day-partitioned Parquet of 1-minute traffic, uploaded to the object store when one is set. */
	async exportParquet(options: ParquetExportOptions): Promise<{ files: string[]; bytes: number }> {
		return this.#guarded('exportParquet', { files: [], bytes: 0 }, async () => {
			const fromMs = toEpochMs(options.from);
			const toMs = toEpochMs(options.to);
			if (toMs < fromMs) return { files: [], bytes: 0 };
			await mkdir(options.dir, { recursive: true });

			const client = this.#write();
			const days = await client.query<{ day: string; n: number }>(
				`SELECT toString(toDate(bucket)) AS day, count() AS n FROM ${this.database}.traffic_1m
				WHERE bucket >= {from:DateTime('UTC')} AND bucket < {to:DateTime('UTC')}
				GROUP BY day ORDER BY day`,
				{ params: { from: chDateTime(fromMs), to: chDateTime(toMs) }, settings: READ_SETTINGS },
			);
			const files: string[] = [];
			for (const { day } of days) {
				const dayStart = Date.parse(`${day}T00:00:00Z`);
				const data = await client.queryBytes(
					`SELECT ${TRAFFIC_COLUMNS.join(', ')}, toDate(bucket) AS day FROM ${this.database}.traffic_1m
					WHERE bucket >= {from:DateTime('UTC')} AND bucket < {to:DateTime('UTC')}
					ORDER BY host, bucket
					FORMAT Parquet`,
					{
						params: { from: chDateTime(Math.max(fromMs, dayStart)), to: chDateTime(Math.min(toMs, dayStart + DAY_MS)) },
						settings: { ...READ_SETTINGS, output_format_parquet_compression_method: 'zstd' },
					},
				);
				const file = join(options.dir, `day=${day}`, 'data_0.parquet');
				await mkdir(dirname(file), { recursive: true });
				await writeFile(file, data);
				files.push(file);
			}
			if (files.length === 0) return { files: [], bytes: 0 };

			let bytes = 0;
			for (const file of files) bytes += (await stat(file)).size;

			const objectStore = options.objectStore ?? this.#objectStore;
			if (!objectStore) return { files, bytes };
			for (const file of files) {
				const rel = relative(options.dir, file).split(sep).join('/');
				const match = /(?:^|\/)day=(\d{4}-\d{2}-\d{2})\/(.+)$/.exec(rel);
				const key = match?.[1] !== undefined && match[2] !== undefined ? `telemetry/${match[1]}/${match[2]}` : `telemetry/${rel}`;
				await objectStore.put(key, new Uint8Array(await readFile(file)), 'application/vnd.apache.parquet');
			}
			await this.#removeExportedFiles(files, options.dir);
			return { files, bytes };
		});
	}

	async getPrometheusMetrics(host?: string): Promise<string> {
		return this.#guarded('getPrometheusMetrics', '', async () => {
			const toMs = this.#now();
			const params: ClickHouseParams = { from: chDateTime(toMs - HOUR_MS), to: chDateTime(toMs) };
			let where = '';
			if (host !== undefined) {
				where = 'AND host = {host:String}';
				params.host = host;
			}
			const rows = await this.#read(
				`SELECT host,
					toFloat64(sum(requests)) AS requests,
					toFloat64(sum(status_5xx)) AS errors,
					toFloat64(sum(bytes)) AS bytes
				FROM ${this.database}.traffic_1m
				WHERE bucket >= {from:DateTime('UTC')} AND bucket <= {to:DateTime('UTC')} ${where}
				GROUP BY host
				ORDER BY host ASC`,
				params,
			);

			const lines: string[] = [
				'# HELP skiff_http_requests_total HTTP requests observed in the last hour.',
				'# TYPE skiff_http_requests_total gauge',
			];
			let errors = 0;
			let bytes = 0;
			for (const row of rows) {
				const name = escapePrometheusLabel(readString(row['host']));
				lines.push(`skiff_http_requests_total{host="${name}"} ${prometheusNumber(readNumber(row['requests']))}`);
				errors += readNumber(row['errors']);
				bytes += readNumber(row['bytes']);
			}
			lines.push('# HELP skiff_http_errors_total 5xx responses observed in the last hour.', '# TYPE skiff_http_errors_total gauge');
			if (rows.length > 0) lines.push(`skiff_http_errors_total{class="5xx"} ${prometheusNumber(errors)}`);
			lines.push('# HELP skiff_bytes_total Response bytes served in the last hour.', '# TYPE skiff_bytes_total gauge');
			if (rows.length > 0) lines.push(`skiff_bytes_total ${prometheusNumber(bytes)}`);

			if (host === undefined) {
				// Managed databases: the newest sample from the last five minutes (D57).
				const dbSamples = await this.#read(dbLatestSql(this.database), { since: chDateTime(toMs - 5 * MINUTE_MS) });
				const dbSeries: Array<[string, string, string]> = [
					['skiff_database_up', 'up', 'Whether the database answered its last sample (1 = up).'],
					['skiff_database_size_bytes', 'size_bytes', 'Database size on disk.'],
					['skiff_database_connections', 'connections_total', 'Open connections.'],
					['skiff_database_max_connections', 'max_connections', 'Configured max_connections.'],
					['skiff_database_pooler_up', 'pooler_up', 'Whether the PgBouncer admin console answered (1 = up).'],
					['skiff_database_pool_active', 'pool_active', 'PgBouncer client/server connections in use.'],
					['skiff_database_pool_idle', 'pool_idle', 'Idle PgBouncer server connections.'],
					['skiff_database_pool_waiting', 'pool_waiting', 'Clients waiting for a PgBouncer server connection.'],
					['skiff_database_pool_saturation', 'pool_saturation', 'Share of max_client_conn in use (0–1).'],
					['skiff_database_pool_avg_wait_ms', 'pool_avg_wait_ms', 'Average PgBouncer wait, milliseconds.'],
				];
				for (const [name, column, help] of dbSeries) {
					lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
					for (const sample of dbSamples) {
						const id = escapePrometheusLabel(readString(sample['database_id']));
						lines.push(`${name}{database_id="${id}"} ${prometheusNumber(readNumber(sample[column]))}`);
					}
				}

				// Managed object storage: the newest sample from the last five minutes (S7).
				const stSamples = await this.#read(storageLatestSql(this.database), { since: chDateTime(toMs - 5 * MINUTE_MS) });
				const stSeries: Array<[string, string, string]> = [
					['skiff_storage_up', 'up', 'Whether the storage instance answered its last sample (1 = up).'],
					['skiff_storage_used_bytes', 'used_bytes', 'Bytes stored across buckets.'],
					['skiff_storage_objects', 'objects', 'Objects stored across buckets.'],
					['skiff_storage_buckets', 'bucket_count', 'Buckets on the instance.'],
				];
				for (const [name, column, help] of stSeries) {
					lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
					for (const sample of stSamples) {
						const id = escapePrometheusLabel(readString(sample['storage_id']));
						lines.push(`${name}{storage_id="${id}"} ${prometheusNumber(readNumber(sample[column]))}`);
					}
				}
			}
			return `${lines.join('\n')}\n`;
		});
	}

	/**
	 * Raw rows for an org-scoped Prometheus scrape (`MetricsService.prometheus(principal)`): the
	 * last hour of traffic per project, the newest database and storage samples from the last five
	 * minutes, and last-hour database counter sums. Every query is filtered to the ids passed in,
	 * so the caller's tenancy decides what is read. Fail-open: an unavailable store returns empty
	 * lists.
	 */
	async scrapeSamples(input: {
		projectIds: string[];
		databaseIds: string[];
		storageIds: string[];
		brokerIds?: string[];
	}): Promise<ScrapeSamples> {
		const empty: ScrapeSamples = { traffic: [], databases: [], databaseCounters: [], storage: [], brokers: [], brokerCounters: [] };
		return this.#guarded('scrapeSamples', empty, async () => {
			const toMs = this.#now();
			const hour = { from: chDateTime(toMs - HOUR_MS), to: chDateTime(toMs) };
			const since = chDateTime(toMs - 5 * MINUTE_MS);
			// Large id lists stay out of the URL (params travel as `param_*`): read every project's
			// hour (one row each) and filter here instead.
			const filterInSql = input.projectIds.length <= 500;
			const wanted = new Set(input.projectIds);
			const trafficRows =
				input.projectIds.length === 0
					? []
					: await this.#read(
							`SELECT project_id,
								toFloat64(sum(requests)) AS requests,
								toFloat64(sum(status_2xx)) AS status_2xx,
								toFloat64(sum(status_3xx)) AS status_3xx,
								toFloat64(sum(status_4xx)) AS status_4xx,
								toFloat64(sum(status_5xx)) AS status_5xx,
								toFloat64(sum(bytes)) AS bytes,
								if(sum(requests) = 0, 0, sum(duration_p50_ms * requests) / sum(requests)) AS duration_p50_ms,
								if(sum(requests) = 0, 0, sum(duration_p95_ms * requests) / sum(requests)) AS duration_p95_ms
							FROM ${this.database}.traffic_1m
							WHERE bucket >= {from:DateTime('UTC')} AND bucket <= {to:DateTime('UTC')}
								${filterInSql ? 'AND project_id IN {projectIds:Array(String)}' : 'AND project_id IS NOT NULL'}
							GROUP BY project_id
							ORDER BY project_id`,
							filterInSql ? { ...hour, projectIds: input.projectIds } : hour,
						);
			const traffic = trafficRows.filter((row) => wanted.has(readString(row['project_id'])));
			const databaseIds = new Set(input.databaseIds);
			const storageIds = new Set(input.storageIds);
			const databases =
				databaseIds.size === 0
					? []
					: (await this.#read(dbLatestSql(this.database), { since })).filter((row) => databaseIds.has(readString(row['database_id'])));
			const databaseCounters =
				databaseIds.size === 0
					? []
					: await this.#read(
							`SELECT database_id, ${DB_COUNTERS.map(([c]) => `toFloat64(sum(${c})) AS ${c}`).join(', ')}
							FROM ${this.database}.db_metrics_1m
							WHERE bucket >= {from:DateTime('UTC')} AND bucket <= {to:DateTime('UTC')}
								AND database_id IN {databaseIds:Array(String)}
							GROUP BY database_id
							ORDER BY database_id`,
							{ ...hour, databaseIds: [...databaseIds] },
						);
			const storage =
				storageIds.size === 0
					? []
					: (await this.#read(storageLatestSql(this.database), { since })).filter((row) => storageIds.has(readString(row['storage_id'])));
			const brokerIds = new Set(input.brokerIds ?? []);
			const brokers =
				brokerIds.size === 0
					? []
					: (await this.#read(brokerLatestSql(this.database), { since })).filter((row) => brokerIds.has(readString(row['broker_id'])));
			const brokerCounters =
				brokerIds.size === 0 ? [] : await this.#read(brokerCountersSql(this.database), { ...hour, brokerIds: [...brokerIds] });
			return {
				traffic: traffic.map((row) => ({
					projectId: readString(row['project_id']),
					requests: readNumber(row['requests']),
					status2xx: readNumber(row['status_2xx']),
					status3xx: readNumber(row['status_3xx']),
					status4xx: readNumber(row['status_4xx']),
					status5xx: readNumber(row['status_5xx']),
					bytes: readNumber(row['bytes']),
					durationP50Ms: readNumber(row['duration_p50_ms']),
					durationP95Ms: readNumber(row['duration_p95_ms']),
				})),
				databases: databases.map((row) => numericRow(row, 'database_id')),
				databaseCounters: databaseCounters.map((row) => numericRow(row, 'database_id')),
				storage: storage.map((row) => numericRow(row, 'storage_id')),
				brokers: brokers.map((row) => numericRow(row, 'broker_id')),
				brokerCounters: brokerCounters.map((row) => numericRow(row, 'broker_id')),
			};
		});
	}

	// --- ad-hoc queries (dashboards, D101) ------------------------------------------------------

	/**
	 * Run dashboard SQL and return column metadata with positional rows. Unlike the methods above
	 * this throws: a dashboard needs the ClickHouse message for a bad query. `asReader` runs it as
	 * the read-only user (or the writer with `readonly = 2`); builder SQL generated by the control
	 * plane passes false.
	 */
	async runQuery(sql: string, options: AdHocQueryOptions & { asReader: boolean }): Promise<ClickHouseCompactResult> {
		if (!(await this.ready()) || !this.#client) throw new ClickHouseUnavailableError(this.error?.message ?? 'Telemetry is unavailable');
		const settings: ClickHouseSettings = { ...READ_SETTINGS, ...AD_HOC_LIMITS, ...options.settings };
		const client = options.asReader ? (this.#reader ?? this.#client.with({ database: this.database })) : this.#client.with({ database: this.database });
		if (options.asReader && !this.#reader) settings.readonly = 2;
		if (options.asReader && this.#reader) {
			// The reader profile already sets final and caps the limits; readonly is constant there.
			delete settings.final;
			delete settings.do_not_merge_across_partitions_select_final;
		}
		try {
			return await client.queryCompact(sql, { params: options.params, settings, signal: options.signal });
		} catch (error) {
			if (error instanceof ClickHouseUnavailableError) this.#markUnavailable(error);
			throw error;
		}
	}

	/** Tables (and views) in the telemetry database with their columns. */
	async tables(): Promise<TelemetryTable[]> {
		return this.#guarded('tables', [], async () => {
			const client = this.#write();
			const tables = await client.query<{ name: string; engine: string; total_rows: number | null; total_bytes: number | null; comment: string }>(
				`SELECT name, engine, total_rows, total_bytes, comment FROM system.tables WHERE database = {db:String} ORDER BY name`,
				{ params: { db: this.database } },
			);
			const columns = await client.query<{ table: string; name: string; type: string; comment: string }>(
				`SELECT table, name, type, comment FROM system.columns WHERE database = {db:String} ORDER BY table, position`,
				{ params: { db: this.database } },
			);
			return tables.map((table) => ({
				name: table.name,
				engine: table.engine,
				rows: readNumber(table.total_rows),
				bytes: readNumber(table.total_bytes),
				comment: table.comment,
				columns: columns
					.filter((column) => column.table === table.name && column.name !== 'version')
					.map(({ name, type, comment }) => ({ name, type, comment })),
			}));
		});
	}

	/** Server version, telemetry size on disk and memory, for Settings → Telemetry. Null when down. */
	async stats(): Promise<TelemetryStats | null> {
		if (!this.#client || !(await this.ready())) return null;
		try {
			const client = this.#write();
			const [server] = await client.query<{ version: string; uptime: number }>('SELECT version() AS version, uptime() AS uptime');
			const [parts] = await client.query<{ bytes: number; rows: number }>(
				`SELECT sum(bytes_on_disk) AS bytes, sum(rows) AS rows FROM system.parts WHERE active AND database = {db:String}`,
				{ params: { db: this.database } },
			);
			const [memory] = await client.query<{ bytes: number }>(
				`SELECT value AS bytes FROM system.metrics WHERE metric = 'MemoryTracking'`,
			);
			return {
				version: server?.version ?? 'unknown',
				uptimeSeconds: readNumber(server?.uptime),
				bytesOnDisk: readNumber(parts?.bytes),
				rows: readNumber(parts?.rows),
				memoryBytes: readNumber(memory?.bytes),
			};
		} catch (error) {
			if (error instanceof ClickHouseUnavailableError) this.#markUnavailable(error);
			else this.#report('stats', error);
			return null;
		}
	}

	// --- internals ------------------------------------------------------------------------------

	async #doOpen(): Promise<void> {
		const client = this.#client;
		if (!client) return;
		try {
			const db = this.database;
			await client.exec(`CREATE DATABASE IF NOT EXISTS ${db}`);
			const rawTtl = this.#tableTtl ? `INTERVAL ${this.#rawRetentionHours + 24} HOUR` : 'INTERVAL 100 YEAR';
			const hourTtl = this.#tableTtl ? `INTERVAL ${this.#hourlyRetentionDays + 7} DAY` : 'INTERVAL 100 YEAR';
			await client.exec(trafficTableSql(db, 'traffic_1m', rawTtl, 'toYYYYMMDD(bucket)'));
			await client.exec(trafficTableSql(db, 'traffic_1h', hourTtl, 'toYYYYMM(bucket)'));
			await client.exec(dbMetricsTableSql(db, 'db_metrics_1m', rawTtl, 'toYYYYMMDD(bucket)'));
			await client.exec(dbMetricsTableSql(db, 'db_metrics_1h', hourTtl, 'toYYYYMM(bucket)'));
			await client.exec(storageMetricsTableSql(db, 'storage_metrics_1m', rawTtl, 'toYYYYMMDD(bucket)'));
			await client.exec(storageMetricsTableSql(db, 'storage_metrics_1h', hourTtl, 'toYYYYMM(bucket)'));
			await client.exec(brokerMetricsTableSql(db, 'broker_metrics_1m', rawTtl, 'toYYYYMMDD(bucket)'));
			await client.exec(brokerMetricsTableSql(db, 'broker_metrics_1h', hourTtl, 'toYYYYMM(bucket)'));
			// Analytics Engine datapoints (docs/FUNCTIONS.md §4.5): raw events, its own 90-day TTL.
			await client.exec(analyticsTableSql(db));
			// Tail-worker items (phase 3): structured invocation logs, independent 30-day TTL.
			await client.exec(tailEventsTableSql(db));
			// Hourly views for dashboard SQL: every hour in retention, rolled or not.
			await client.exec(
				hourlyViewSql(db, 'traffic_hourly', 'traffic', 'host', [
					['project_id', 'argMax(project_id, bucket)'],
					['requests', 'sum(requests)'],
					['status_2xx', 'sum(status_2xx)'],
					['status_3xx', 'sum(status_3xx)'],
					['status_4xx', 'sum(status_4xx)'],
					['status_5xx', 'sum(status_5xx)'],
					['bytes', 'sum(bytes)'],
					['duration_p50_ms', weighted('duration_p50_ms')],
					['duration_p95_ms', weighted('duration_p95_ms')],
					['top_paths', 'sumMap(top_paths)'],
					['top_referrers', 'sumMap(top_referrers)'],
				]),
			);
			await client.exec(
				hourlyViewSql(db, 'db_metrics_hourly', 'db_metrics', 'database_id', [
					...DB_GAUGES.map(([c]) => [c, DB_MAX_GAUGES.has(c) ? `max(${c})` : `avg(${c})`] as const),
					...DB_COUNTERS.map(([c]) => [c, `sum(${c})`] as const),
				]),
			);
			await client.exec(
				hourlyViewSql(
					db,
					'storage_metrics_hourly',
					'storage_metrics',
					'storage_id',
					ST_GAUGES.map(([c]) => [c, ST_MAX_GAUGES.has(c) ? `max(${c})` : `avg(${c})`] as const),
				),
			);
			await client.exec(
				hourlyViewSql(db, 'broker_metrics_hourly', 'broker_metrics', 'broker_id', [
					...MQ_GAUGES.map(([c]) => [c, brokerGaugeAggregate(c)] as const),
					...MQ_COUNTERS.map(([c]) => [c, `sum(${c})`] as const),
				]),
			);
			this.error = null;
			this.available = true;
		} catch (error) {
			const cause = asError(error);
			this.error = new Error(`Telemetry (ClickHouse) unavailable: ${cause.message}`, { cause });
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
			if (error instanceof ClickHouseUnavailableError) this.#markUnavailable(error);
			else this.#report(operation, error);
			return fallback;
		}
	}

	/** The server went away: report it and reconnect (re-checking the schema) after the window. */
	#markUnavailable(error: Error): void {
		this.available = false;
		this.#retryOpenAt = this.#now() + this.#openRetryMs;
		this.error = new Error(`Telemetry (ClickHouse) unavailable: ${error.message}`, { cause: error });
		this.#notify(this.error);
	}

	#serialize<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.#writeTail.then(fn, fn);
		this.#writeTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	#write(): ClickHouseClient {
		if (!this.#client) throw new Error('Telemetry store is not configured');
		return this.#client;
	}

	async #read(sql: string, params: ClickHouseParams): Promise<Record<string, unknown>[]> {
		return this.#write().query(sql, { params, settings: READ_SETTINGS });
	}

	/** Strictly increasing per process, so a re-sent row always outranks the one it replaces. */
	#nextVersion(): number {
		this.#lastVersion = Math.max(this.#lastVersion + 1, this.#now(), Date.now());
		return this.#lastVersion;
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
		const message = error instanceof ClickHouseError ? error.message : error.message;
		const wrapped = new Error(`Telemetry ${operation} failed: ${message}`, { cause: error });
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

/** Read the ClickHouse connection from the environment (control plane and CLI tools). */
export function clickhouseFromEnv(env: Record<string, string | undefined> = process.env): {
	clickhouse?: ClickHouseConfig;
	reader?: { user: string; password: string };
} {
	const url = env.SKIFF_CLICKHOUSE_URL?.trim();
	if (!url) return {};
	const readerUser = env.SKIFF_CLICKHOUSE_READER_USER?.trim();
	return {
		clickhouse: {
			url,
			user: env.SKIFF_CLICKHOUSE_USER?.trim() || 'skiff',
			password: env.SKIFF_CLICKHOUSE_PASSWORD ?? '',
			database: env.SKIFF_CLICKHOUSE_DATABASE?.trim() || 'skiff',
		},
		reader: readerUser ? { user: readerUser, password: env.SKIFF_CLICKHOUSE_READER_PASSWORD ?? '' } : undefined,
	};
}

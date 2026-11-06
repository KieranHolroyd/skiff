/**
 * ClickHouse SQL for managed-database time series (docs/DATABASES.md §5, D57, D101). Kept apart
 * from the traffic SQL in `telemetry.ts`; the store owns the client and serialization.
 *
 * Gauges are Float64 so hourly rows can hold averages (`up` becomes availability); counters are
 * per-minute deltas and sum cleanly. Tables are ReplacingMergeTree keyed by (database_id, bucket):
 * a re-sent minute replaces the earlier row once read with `final = 1`.
 */

export const DB_GAUGES = [
	['up', 'up'],
	['size_bytes', 'sizeBytes'],
	['connections_active', 'connectionsActive'],
	['connections_idle', 'connectionsIdle'],
	['connections_total', 'connectionsTotal'],
	['max_connections', 'maxConnections'],
	['memory_bytes', 'memoryBytes'],
	['pooler_up', 'poolerUp'],
	['pool_active', 'poolActive'],
	['pool_idle', 'poolIdle'],
	['pool_waiting', 'poolWaiting'],
	['pool_saturation', 'poolSaturation'],
	['pool_avg_wait_ms', 'poolAvgWaitMs'],
] as const;

export const DB_COUNTERS = [
	['xact_commit', 'xactCommit'],
	['xact_rollback', 'xactRollback'],
	['tup_returned', 'tupReturned'],
	['tup_fetched', 'tupFetched'],
	['tup_inserted', 'tupInserted'],
	['tup_updated', 'tupUpdated'],
	['tup_deleted', 'tupDeleted'],
	['blks_hit', 'blksHit'],
	['blks_read', 'blksRead'],
	['deadlocks', 'deadlocks'],
	['temp_bytes', 'tempBytes'],
] as const;

/** Size and memory take the max over a bucket; other gauges average. */
export const DB_MAX_GAUGES = new Set<string>(['size_bytes', 'memory_bytes', 'max_connections']);

export const DB_COLUMNS = ['database_id', 'bucket', ...DB_GAUGES.map(([c]) => c), ...DB_COUNTERS.map(([c]) => c)];

const GAUGE_COMMENTS: Record<string, string> = {
	up: '1 when the database answered its sample (hourly: availability 0-1)',
	size_bytes: 'Database size on disk, bytes',
	connections_active: 'Active backend connections',
	connections_idle: 'Idle backend connections',
	connections_total: 'Open backend connections',
	max_connections: 'Configured max_connections',
	memory_bytes: 'Container memory use, bytes',
	pooler_up: '1 when the PgBouncer admin console answered',
	pool_active: 'PgBouncer connections in use',
	pool_idle: 'Idle PgBouncer server connections',
	pool_waiting: 'Clients waiting for a PgBouncer server connection',
	pool_saturation: 'Share of max_client_conn in use (0-1)',
	pool_avg_wait_ms: 'Average PgBouncer wait, milliseconds',
};

export const dbMetricsTableSql = (database: string, table: string, ttl: string, partition: string): string => `
	CREATE TABLE IF NOT EXISTS ${database}.${table} (
		database_id LowCardinality(String) COMMENT 'Managed database id (dbs_...)',
		bucket DateTime('UTC') COMMENT 'Bucket start (UTC)',
		${DB_GAUGES.map(([c]) => `${c} Float64 COMMENT '${GAUGE_COMMENTS[c] ?? ''}'`).join(',\n\t\t')},
		${DB_COUNTERS.map(([c]) => `${c} UInt64 COMMENT 'pg_stat_database ${c} delta in the bucket'`).join(',\n\t\t')},
		version UInt64 COMMENT 'Ingest time (ms); the newest row per key wins'
	) ENGINE = ReplacingMergeTree(version)
	PARTITION BY ${partition}
	ORDER BY (database_id, bucket)
	TTL bucket + ${ttl}
	COMMENT 'Managed database samples'`;

/** Aggregates for one bucket of rows, used by the rollup and by hourly queries. */
export function dbAggregateSelect(): string {
	const gauges = DB_GAUGES.map(([c]) => (DB_MAX_GAUGES.has(c) ? `max(${c}) AS ${c}` : `avg(${c}) AS ${c}`));
	const counters = DB_COUNTERS.map(([c]) => `sum(${c}) AS ${c}`);
	return [...gauges, ...counters].join(', ');
}

/** Recompute closed hours (`{from}` ≤ bucket < hour of `{to}`) into db_metrics_1h. */
export const dbRollupSql = (database: string): string => `
	INSERT INTO ${database}.db_metrics_1h (${DB_COLUMNS.join(', ')}, version)
	SELECT database_id, toStartOfHour(bucket) AS hour, ${dbAggregateSelect()}, {version:UInt64}
	FROM ${database}.db_metrics_1m
	WHERE bucket >= {from:DateTime('UTC')} AND bucket < toStartOfHour({to:DateTime('UTC')})
	GROUP BY database_id, hour`;

const ALL_DB_COLUMNS = [...DB_GAUGES, ...DB_COUNTERS].map(([c]) => c);

/** Minute or hour series for one database; hours not rolled up yet fall back to minute rows. */
export function dbSeriesSql(database: string, interval: '1m' | '1h'): string {
	if (interval === '1m')
		return `
			SELECT toUnixTimestamp(bucket) * 1000 AS bucket_ms, ${ALL_DB_COLUMNS.map((c) => `toFloat64(${c}) AS ${c}`).join(', ')}
			FROM ${database}.db_metrics_1m
			WHERE database_id = {id:String} AND bucket >= {from:DateTime('UTC')} AND bucket <= {to:DateTime('UTC')}
			ORDER BY bucket ASC`;
	return `
		SELECT toUnixTimestamp(toStartOfHour(bucket)) * 1000 AS bucket_ms,
			${dbAggregateSelect()}
		FROM (
			SELECT ${['bucket', ...ALL_DB_COLUMNS].join(', ')} FROM ${database}.db_metrics_1h
			WHERE database_id = {id:String} AND bucket >= toStartOfHour({from:DateTime('UTC')}) AND bucket <= {to:DateTime('UTC')}
			UNION ALL
			SELECT ${['bucket', ...ALL_DB_COLUMNS].join(', ')} FROM ${database}.db_metrics_1m
			WHERE database_id = {id:String} AND bucket >= {from:DateTime('UTC')} AND bucket <= {to:DateTime('UTC')}
				AND (database_id, toStartOfHour(bucket)) NOT IN (
					SELECT database_id, bucket FROM ${database}.db_metrics_1h
					WHERE database_id = {id:String} AND bucket >= toStartOfHour({from:DateTime('UTC')}) AND bucket <= {to:DateTime('UTC')}
				)
		)
		GROUP BY bucket_ms
		ORDER BY bucket_ms ASC`;
}

/** Newest minute sample per database since a cutoff (alerts, `/metrics`). */
export const dbLatestSql = (database: string): string => `
	SELECT database_id,
		argMax(up, bucket) AS up,
		argMax(size_bytes, bucket) AS size_bytes,
		argMax(connections_total, bucket) AS connections_total,
		argMax(max_connections, bucket) AS max_connections,
		argMax(memory_bytes, bucket) AS memory_bytes,
		argMax(pooler_up, bucket) AS pooler_up,
		argMax(pool_active, bucket) AS pool_active,
		argMax(pool_idle, bucket) AS pool_idle,
		argMax(pool_waiting, bucket) AS pool_waiting,
		argMax(pool_saturation, bucket) AS pool_saturation,
		argMax(pool_avg_wait_ms, bucket) AS pool_avg_wait_ms
	FROM ${database}.db_metrics_1m
	WHERE bucket >= {since:DateTime('UTC')}
	GROUP BY database_id
	ORDER BY database_id`;

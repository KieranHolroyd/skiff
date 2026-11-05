/**
 * DuckDB SQL for managed-database time series (docs/DATABASES.md §5, D57). Kept apart from the
 * traffic SQL in `telemetry.ts`; the store owns connections and serialization.
 *
 * Gauges are DOUBLE so hourly rows can hold averages (`up` becomes availability); counters are
 * per-minute deltas and sum cleanly.
 */

export const DB_GAUGES = [
	['up', 'up'],
	['size_bytes', 'sizeBytes'],
	['connections_active', 'connectionsActive'],
	['connections_idle', 'connectionsIdle'],
	['connections_total', 'connectionsTotal'],
	['max_connections', 'maxConnections'],
	['memory_bytes', 'memoryBytes'],
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
const MAX_GAUGES = new Set(['size_bytes', 'memory_bytes', 'max_connections']);

export const DB_COLUMNS = ['database_id', 'bucket', ...DB_GAUGES.map(([c]) => c), ...DB_COUNTERS.map(([c]) => c)];

export const dbMetricsTableSql = (table: string): string => `
	CREATE TABLE IF NOT EXISTS ${table} (
		database_id VARCHAR NOT NULL,
		bucket TIMESTAMPTZ NOT NULL,
		${DB_GAUGES.map(([c]) => `${c} DOUBLE NOT NULL`).join(',\n\t\t')},
		${DB_COUNTERS.map(([c]) => `${c} UBIGINT NOT NULL`).join(',\n\t\t')}
	)`;

/** Aggregates for one bucket of rows, used by the rollup and by hourly queries. */
export function dbAggregateSelect(): string {
	const gauges = DB_GAUGES.map(([c]) => (MAX_GAUGES.has(c) ? `max(${c}) AS ${c}` : `avg(${c}) AS ${c}`));
	const counters = DB_COUNTERS.map(([c]) => `CAST(sum(${c}) AS UBIGINT) AS ${c}`);
	return [...gauges, ...counters].join(', ');
}

export const DB_ROLLUP_DELETE_SQL = `
	DELETE FROM db_metrics_1h USING (
		SELECT DISTINCT database_id, date_trunc('hour', bucket) AS bucket
		FROM db_metrics_1m
		WHERE bucket >= CAST(? AS TIMESTAMPTZ)
			AND bucket < date_trunc('hour', CAST(? AS TIMESTAMPTZ))
	) s
	WHERE db_metrics_1h.database_id = s.database_id AND db_metrics_1h.bucket = s.bucket`;

export const DB_ROLLUP_INSERT_SQL = `
	INSERT INTO db_metrics_1h (${DB_COLUMNS.join(', ')})
	SELECT database_id, date_trunc('hour', bucket) AS bucket, ${dbAggregateSelect()}
	FROM db_metrics_1m
	WHERE bucket >= CAST(? AS TIMESTAMPTZ)
		AND bucket < date_trunc('hour', CAST(? AS TIMESTAMPTZ))
	GROUP BY database_id, date_trunc('hour', bucket)`;

/** Minute or hour series for one database; hours not rolled up yet fall back to minute rows. */
export function dbSeriesSql(interval: '1m' | '1h'): string {
	if (interval === '1m')
		return `
			SELECT epoch_ms(bucket) AS bucket_ms, ${[...DB_GAUGES, ...DB_COUNTERS].map(([c]) => `CAST(${c} AS DOUBLE) AS ${c}`).join(', ')}
			FROM db_metrics_1m
			WHERE database_id = ? AND bucket >= CAST(? AS TIMESTAMPTZ) AND bucket <= CAST(? AS TIMESTAMPTZ)
			ORDER BY bucket ASC`;
	return `
		SELECT epoch_ms(date_trunc('hour', bucket)) AS bucket_ms,
			${dbAggregateSelect().replace(/AS UBIGINT/g, 'AS DOUBLE')}
		FROM (
			SELECT * FROM db_metrics_1h
			WHERE database_id = ? AND bucket >= date_trunc('hour', CAST(? AS TIMESTAMPTZ)) AND bucket <= CAST(? AS TIMESTAMPTZ)
			UNION ALL
			SELECT * FROM db_metrics_1m m
			WHERE database_id = ? AND bucket >= CAST(? AS TIMESTAMPTZ) AND bucket <= CAST(? AS TIMESTAMPTZ)
				AND NOT EXISTS (
					SELECT 1 FROM db_metrics_1h h
					WHERE h.database_id = m.database_id AND h.bucket = date_trunc('hour', m.bucket)
				)
		)
		GROUP BY date_trunc('hour', bucket)
		ORDER BY bucket_ms ASC`;
}

/** Newest minute sample per database since a cutoff (alerts, `/metrics`). */
export const DB_LATEST_SQL = `
	SELECT database_id,
		arg_max(up, bucket) AS up,
		arg_max(size_bytes, bucket) AS size_bytes,
		arg_max(connections_total, bucket) AS connections_total,
		arg_max(max_connections, bucket) AS max_connections,
		arg_max(memory_bytes, bucket) AS memory_bytes
	FROM db_metrics_1m
	WHERE bucket >= CAST(? AS TIMESTAMPTZ)
	GROUP BY database_id
	ORDER BY database_id`;

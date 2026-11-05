/**
 * DuckDB SQL for managed object storage time series (docs/OBJECT-STORAGE.md §6, S7). Mirrors
 * `database-metrics-sql.ts`; the store owns connections and serialization.
 *
 * Everything is a gauge (DOUBLE, so hourly rows can hold averages and `up` becomes availability).
 * Sizes, counts and memory take the max over an hour.
 */

export const ST_GAUGES = [
	['up', 'up'],
	['used_bytes', 'usedBytes'],
	['objects', 'objects'],
	['bucket_count', 'bucketCount'],
	['memory_bytes', 'memoryBytes'],
] as const;

const MAX_GAUGES = new Set(['used_bytes', 'objects', 'bucket_count', 'memory_bytes']);

export const ST_COLUMNS = ['storage_id', 'bucket', ...ST_GAUGES.map(([c]) => c)];

export const storageMetricsTableSql = (table: string): string => `
	CREATE TABLE IF NOT EXISTS ${table} (
		storage_id VARCHAR NOT NULL,
		bucket TIMESTAMPTZ NOT NULL,
		${ST_GAUGES.map(([c]) => `${c} DOUBLE NOT NULL`).join(',\n\t\t')}
	)`;

export function storageAggregateSelect(): string {
	return ST_GAUGES.map(([c]) => (MAX_GAUGES.has(c) ? `max(${c}) AS ${c}` : `avg(${c}) AS ${c}`)).join(', ');
}

export const ST_ROLLUP_DELETE_SQL = `
	DELETE FROM storage_metrics_1h USING (
		SELECT DISTINCT storage_id, date_trunc('hour', bucket) AS bucket
		FROM storage_metrics_1m
		WHERE bucket >= CAST(? AS TIMESTAMPTZ)
			AND bucket < date_trunc('hour', CAST(? AS TIMESTAMPTZ))
	) s
	WHERE storage_metrics_1h.storage_id = s.storage_id AND storage_metrics_1h.bucket = s.bucket`;

export const ST_ROLLUP_INSERT_SQL = `
	INSERT INTO storage_metrics_1h (${ST_COLUMNS.join(', ')})
	SELECT storage_id, date_trunc('hour', bucket) AS bucket, ${storageAggregateSelect()}
	FROM storage_metrics_1m
	WHERE bucket >= CAST(? AS TIMESTAMPTZ)
		AND bucket < date_trunc('hour', CAST(? AS TIMESTAMPTZ))
	GROUP BY storage_id, date_trunc('hour', bucket)`;

/** Minute or hour series for one instance; hours not rolled up yet fall back to minute rows. */
export function storageSeriesSql(interval: '1m' | '1h'): string {
	if (interval === '1m')
		return `
			SELECT epoch_ms(bucket) AS bucket_ms, ${ST_GAUGES.map(([c]) => `CAST(${c} AS DOUBLE) AS ${c}`).join(', ')}
			FROM storage_metrics_1m
			WHERE storage_id = ? AND bucket >= CAST(? AS TIMESTAMPTZ) AND bucket <= CAST(? AS TIMESTAMPTZ)
			ORDER BY bucket ASC`;
	return `
		SELECT epoch_ms(date_trunc('hour', bucket)) AS bucket_ms, ${storageAggregateSelect()}
		FROM (
			SELECT * FROM storage_metrics_1h
			WHERE storage_id = ? AND bucket >= date_trunc('hour', CAST(? AS TIMESTAMPTZ)) AND bucket <= CAST(? AS TIMESTAMPTZ)
			UNION ALL
			SELECT * FROM storage_metrics_1m m
			WHERE storage_id = ? AND bucket >= CAST(? AS TIMESTAMPTZ) AND bucket <= CAST(? AS TIMESTAMPTZ)
				AND NOT EXISTS (
					SELECT 1 FROM storage_metrics_1h h
					WHERE h.storage_id = m.storage_id AND h.bucket = date_trunc('hour', m.bucket)
				)
		)
		GROUP BY date_trunc('hour', bucket)
		ORDER BY bucket_ms ASC`;
}

/** Newest minute sample per instance since a cutoff (`/metrics`). */
export const ST_LATEST_SQL = `
	SELECT storage_id,
		arg_max(up, bucket) AS up,
		arg_max(used_bytes, bucket) AS used_bytes,
		arg_max(objects, bucket) AS objects,
		arg_max(bucket_count, bucket) AS bucket_count,
		arg_max(memory_bytes, bucket) AS memory_bytes
	FROM storage_metrics_1m
	WHERE bucket >= CAST(? AS TIMESTAMPTZ)
	GROUP BY storage_id
	ORDER BY storage_id`;

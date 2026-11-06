/**
 * ClickHouse SQL for managed object storage time series (docs/OBJECT-STORAGE.md §6, S7, D101).
 * Mirrors `database-metrics-sql.ts`; the store owns the client and serialization.
 *
 * Everything is a gauge (Float64, so hourly rows can hold averages and `up` becomes availability).
 * Sizes, counts and memory take the max over an hour.
 */

export const ST_GAUGES = [
	['up', 'up'],
	['used_bytes', 'usedBytes'],
	['objects', 'objects'],
	['bucket_count', 'bucketCount'],
	['memory_bytes', 'memoryBytes'],
] as const;

export const ST_MAX_GAUGES = new Set<string>(['used_bytes', 'objects', 'bucket_count', 'memory_bytes']);

export const ST_COLUMNS = ['storage_id', 'bucket', ...ST_GAUGES.map(([c]) => c)];

const COMMENTS: Record<string, string> = {
	up: '1 when the instance answered its sample (hourly: availability 0-1)',
	used_bytes: 'Bytes stored across buckets',
	objects: 'Objects stored across buckets',
	bucket_count: 'Buckets on the instance',
	memory_bytes: 'Container memory use, bytes',
};

export const storageMetricsTableSql = (database: string, table: string, ttl: string, partition: string): string => `
	CREATE TABLE IF NOT EXISTS ${database}.${table} (
		storage_id LowCardinality(String) COMMENT 'Storage instance id (sto_...)',
		bucket DateTime('UTC') COMMENT 'Bucket start (UTC)',
		${ST_GAUGES.map(([c]) => `${c} Float64 COMMENT '${COMMENTS[c] ?? ''}'`).join(',\n\t\t')},
		version UInt64 COMMENT 'Ingest time (ms); the newest row per key wins'
	) ENGINE = ReplacingMergeTree(version)
	PARTITION BY ${partition}
	ORDER BY (storage_id, bucket)
	TTL bucket + ${ttl}
	COMMENT 'Managed object storage samples'`;

export function storageAggregateSelect(): string {
	return ST_GAUGES.map(([c]) => (ST_MAX_GAUGES.has(c) ? `max(${c}) AS ${c}` : `avg(${c}) AS ${c}`)).join(', ');
}

export const storageRollupSql = (database: string): string => `
	INSERT INTO ${database}.storage_metrics_1h (${ST_COLUMNS.join(', ')}, version)
	SELECT storage_id, toStartOfHour(bucket) AS hour, ${storageAggregateSelect()}, {version:UInt64}
	FROM ${database}.storage_metrics_1m
	WHERE bucket >= {from:DateTime('UTC')} AND bucket < toStartOfHour({to:DateTime('UTC')})
	GROUP BY storage_id, hour`;

const GAUGE_COLUMNS = ST_GAUGES.map(([c]) => c);

/** Minute or hour series for one instance; hours not rolled up yet fall back to minute rows. */
export function storageSeriesSql(database: string, interval: '1m' | '1h'): string {
	if (interval === '1m')
		return `
			SELECT toUnixTimestamp(bucket) * 1000 AS bucket_ms, ${GAUGE_COLUMNS.map((c) => `toFloat64(${c}) AS ${c}`).join(', ')}
			FROM ${database}.storage_metrics_1m
			WHERE storage_id = {id:String} AND bucket >= {from:DateTime('UTC')} AND bucket <= {to:DateTime('UTC')}
			ORDER BY bucket ASC`;
	return `
		SELECT toUnixTimestamp(toStartOfHour(bucket)) * 1000 AS bucket_ms, ${storageAggregateSelect()}
		FROM (
			SELECT ${['bucket', ...GAUGE_COLUMNS].join(', ')} FROM ${database}.storage_metrics_1h
			WHERE storage_id = {id:String} AND bucket >= toStartOfHour({from:DateTime('UTC')}) AND bucket <= {to:DateTime('UTC')}
			UNION ALL
			SELECT ${['bucket', ...GAUGE_COLUMNS].join(', ')} FROM ${database}.storage_metrics_1m
			WHERE storage_id = {id:String} AND bucket >= {from:DateTime('UTC')} AND bucket <= {to:DateTime('UTC')}
				AND (storage_id, toStartOfHour(bucket)) NOT IN (
					SELECT storage_id, bucket FROM ${database}.storage_metrics_1h
					WHERE storage_id = {id:String} AND bucket >= toStartOfHour({from:DateTime('UTC')}) AND bucket <= {to:DateTime('UTC')}
				)
		)
		GROUP BY bucket_ms
		ORDER BY bucket_ms ASC`;
}

/** Newest minute sample per instance since a cutoff (`/metrics`). */
export const storageLatestSql = (database: string): string => `
	SELECT storage_id,
		argMax(up, bucket) AS up,
		argMax(used_bytes, bucket) AS used_bytes,
		argMax(objects, bucket) AS objects,
		argMax(bucket_count, bucket) AS bucket_count,
		argMax(memory_bytes, bucket) AS memory_bytes
	FROM ${database}.storage_metrics_1m
	WHERE bucket >= {since:DateTime('UTC')}
	GROUP BY storage_id
	ORDER BY storage_id`;

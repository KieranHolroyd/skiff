/**
 * ClickHouse SQL for managed queue broker time series (docs/BROKERS.md §7, D123, D101). Mirrors
 * `database-metrics-sql.ts`; the store owns the client and serialization.
 *
 * Gauges are Float64 so hourly rows can hold averages (`up` becomes availability). Store sizes,
 * backlogs and memory take the max over a bucket, so an hourly point shows the peak. Counters are
 * per-minute deltas and sum cleanly. Tables are ReplacingMergeTree keyed by (broker_id, bucket).
 */

export const MQ_GAUGES = [
	['up', 'up'],
	['connections', 'connections'],
	['streams', 'streams'],
	['consumers', 'consumers'],
	['store_bytes', 'storeBytes'],
	['store_limit_bytes', 'storeLimitBytes'],
	['memory_store_bytes', 'memoryStoreBytes'],
	['messages', 'messages'],
	['pending', 'pending'],
	['ack_pending', 'ackPending'],
	['redelivered', 'redelivered'],
	['oldest_age_seconds', 'oldestAgeSeconds'],
	['memory_bytes', 'memoryBytes'],
] as const;

export const MQ_COUNTERS = [
	['published', 'published'],
	['messages_in', 'messagesIn'],
	['messages_out', 'messagesOut'],
	['bytes_in', 'bytesIn'],
	['bytes_out', 'bytesOut'],
	['slow_consumers', 'slowConsumers'],
] as const;

/** Gauges that average over a bucket; the rest take the max. */
export const MQ_AVG_GAUGES = new Set<string>(['up', 'connections']);

export const MQ_COLUMNS = ['broker_id', 'bucket', ...MQ_GAUGES.map(([c]) => c), ...MQ_COUNTERS.map(([c]) => c)];

const COMMENTS: Record<string, string> = {
	up: '1 when the broker answered its sample (hourly: availability 0-1)',
	connections: 'Client connections, excluding the sampler',
	streams: 'JetStream streams',
	consumers: 'JetStream consumers',
	store_bytes: 'JetStream file store in use, bytes',
	store_limit_bytes: 'File store budget, bytes',
	memory_store_bytes: 'JetStream memory store in use, bytes',
	messages: 'Messages held across streams',
	pending: 'Messages not yet delivered, summed over consumers',
	ack_pending: 'Delivered but unacknowledged messages',
	redelivered: 'Unacknowledged messages delivered more than once',
	oldest_age_seconds: 'Age of the oldest held message, seconds',
	memory_bytes: 'Container memory use, bytes',
	published: 'Messages JetStream stored in the bucket',
	messages_in: 'Messages clients sent to the server in the bucket',
	messages_out: 'Messages the server sent to clients in the bucket',
	bytes_in: 'Bytes clients sent to the server in the bucket',
	bytes_out: 'Bytes the server sent to clients in the bucket',
	slow_consumers: 'Clients cut off as slow consumers in the bucket',
};

export const brokerMetricsTableSql = (database: string, table: string, ttl: string, partition: string): string => `
	CREATE TABLE IF NOT EXISTS ${database}.${table} (
		broker_id LowCardinality(String) COMMENT 'Managed broker id (mq_...)',
		bucket DateTime('UTC') COMMENT 'Bucket start (UTC)',
		${MQ_GAUGES.map(([c]) => `${c} Float64 COMMENT '${COMMENTS[c] ?? ''}'`).join(',\n\t\t')},
		${MQ_COUNTERS.map(([c]) => `${c} UInt64 COMMENT '${COMMENTS[c] ?? ''}'`).join(',\n\t\t')},
		version UInt64 COMMENT 'Ingest time (ms); the newest row per key wins'
	) ENGINE = ReplacingMergeTree(version)
	PARTITION BY ${partition}
	ORDER BY (broker_id, bucket)
	TTL bucket + ${ttl}
	COMMENT 'Managed queue broker samples'`;

/** SQL aggregate for one gauge column over a bucket of rows. */
export function brokerGaugeAggregate(column: string): string {
	return MQ_AVG_GAUGES.has(column) ? `avg(${column})` : `max(${column})`;
}

/** Aggregates for one bucket of rows, used by the rollup and by hourly queries. */
export function brokerAggregateSelect(): string {
	const gauges = MQ_GAUGES.map(([c]) => `${brokerGaugeAggregate(c)} AS ${c}`);
	const counters = MQ_COUNTERS.map(([c]) => `sum(${c}) AS ${c}`);
	return [...gauges, ...counters].join(', ');
}

/** Recompute closed hours (`{from}` ≤ bucket < hour of `{to}`) into broker_metrics_1h. */
export const brokerRollupSql = (database: string): string => `
	INSERT INTO ${database}.broker_metrics_1h (${MQ_COLUMNS.join(', ')}, version)
	SELECT broker_id, toStartOfHour(bucket) AS hour, ${brokerAggregateSelect()}, {version:UInt64}
	FROM ${database}.broker_metrics_1m
	WHERE bucket >= {from:DateTime('UTC')} AND bucket < toStartOfHour({to:DateTime('UTC')})
	GROUP BY broker_id, hour`;

const ALL_COLUMNS = [...MQ_GAUGES, ...MQ_COUNTERS].map(([c]) => c);

/** Minute or hour series for one broker; hours not rolled up yet fall back to minute rows. */
export function brokerSeriesSql(database: string, interval: '1m' | '1h'): string {
	if (interval === '1m')
		return `
			SELECT toUnixTimestamp(bucket) * 1000 AS bucket_ms, ${ALL_COLUMNS.map((c) => `toFloat64(${c}) AS ${c}`).join(', ')}
			FROM ${database}.broker_metrics_1m
			WHERE broker_id = {id:String} AND bucket >= {from:DateTime('UTC')} AND bucket <= {to:DateTime('UTC')}
			ORDER BY bucket ASC`;
	return `
		SELECT toUnixTimestamp(toStartOfHour(bucket)) * 1000 AS bucket_ms, ${brokerAggregateSelect()}
		FROM (
			SELECT ${['bucket', ...ALL_COLUMNS].join(', ')} FROM ${database}.broker_metrics_1h
			WHERE broker_id = {id:String} AND bucket >= toStartOfHour({from:DateTime('UTC')}) AND bucket <= {to:DateTime('UTC')}
			UNION ALL
			SELECT ${['bucket', ...ALL_COLUMNS].join(', ')} FROM ${database}.broker_metrics_1m
			WHERE broker_id = {id:String} AND bucket >= {from:DateTime('UTC')} AND bucket <= {to:DateTime('UTC')}
				AND (broker_id, toStartOfHour(bucket)) NOT IN (
					SELECT broker_id, bucket FROM ${database}.broker_metrics_1h
					WHERE broker_id = {id:String} AND bucket >= toStartOfHour({from:DateTime('UTC')}) AND bucket <= {to:DateTime('UTC')}
				)
		)
		GROUP BY bucket_ms
		ORDER BY bucket_ms ASC`;
}

/** Newest minute sample per broker since a cutoff (`/metrics`). */
export const brokerLatestSql = (database: string): string => `
	SELECT broker_id,
		${MQ_GAUGES.map(([c]) => `argMax(${c}, bucket) AS ${c}`).join(',\n\t\t')}
	FROM ${database}.broker_metrics_1m
	WHERE bucket >= {since:DateTime('UTC')}
	GROUP BY broker_id
	ORDER BY broker_id`;

/** Last-hour sums of the counters per broker (`/metrics`), filtered to `{brokerIds}`. */
export const brokerCountersSql = (database: string): string => `
	SELECT broker_id, ${MQ_COUNTERS.map(([c]) => `toFloat64(sum(${c})) AS ${c}`).join(', ')}
	FROM ${database}.broker_metrics_1m
	WHERE bucket >= {from:DateTime('UTC')} AND bucket <= {to:DateTime('UTC')}
		AND broker_id IN {brokerIds:Array(String)}
	GROUP BY broker_id
	ORDER BY broker_id`;

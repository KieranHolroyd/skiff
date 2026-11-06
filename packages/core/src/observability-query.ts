import type {
	BuilderFilter,
	BuilderMetric,
	BuilderSpec,
	DatasetInfo,
	FieldKind,
	FieldUnit,
	MetricAggregation,
	ObservabilityDataset,
	QueryVariables,
} from '@skiff/contracts';
import { quoteString } from './clickhouse.ts';
import { ValidationError } from './errors.ts';

/**
 * Builder and SQL-macro compilation for observability dashboards (D101). Pure: no I/O, so the
 * SQL it emits is unit-tested without a server.
 *
 * Builder SQL is the trusted path: only catalog names reach the SQL text, every user value is a
 * ClickHouse query parameter, and the caller's tenancy scope is always ANDed in.
 */

const MINUTE_S = 60;
const HOUR_S = 3_600;

/** Allowed bucket widths, seconds. `auto` picks the first that fits `maxDataPoints`. */
const NICE_STEPS = [60, 120, 300, 600, 900, 1_800, 3_600, 7_200, 10_800, 21_600, 43_200, 86_400, 172_800, 604_800];
const FIXED_INTERVALS: Record<string, number> = {
	'1m': 60,
	'5m': 300,
	'15m': 900,
	'30m': 1_800,
	'1h': 3_600,
	'6h': 21_600,
	'12h': 43_200,
	'1d': 86_400,
};

type Family = 'traffic' | 'db_metrics' | 'storage_metrics';

interface MeasureDef {
	name: string;
	label: string;
	kind: FieldKind;
	unit: FieldUnit;
	description?: string;
	/** Derived measures: the full aggregate expression. */
	expression?: string;
	/** Source column for counters and gauges (defaults to `name`). */
	column?: string;
}

interface DatasetDef {
	info: Omit<DatasetInfo, 'measures'>;
	family: Family;
	/** The column the caller's scope filters on. */
	scope: 'project_id' | 'database_id' | 'storage_id';
	/** Datasets over the top_paths/top_referrers maps: one row per (bucket, key). */
	mapColumn?: { column: 'top_paths' | 'top_referrers'; key: string };
	measures: MeasureDef[];
}

const weighted = (column: string) => `if(sum(requests) = 0, 0, sum(${column} * requests) / sum(requests))`;

const trafficMeasures: MeasureDef[] = [
	{ name: 'requests', label: 'Requests', kind: 'counter', unit: 'short' },
	{ name: 'status_2xx', label: '2xx responses', kind: 'counter', unit: 'short' },
	{ name: 'status_3xx', label: '3xx responses', kind: 'counter', unit: 'short' },
	{ name: 'status_4xx', label: '4xx responses', kind: 'counter', unit: 'short' },
	{ name: 'status_5xx', label: '5xx responses', kind: 'counter', unit: 'short' },
	{ name: 'bytes', label: 'Bytes served', kind: 'counter', unit: 'bytes' },
	{
		name: 'duration_p50_ms',
		label: 'p50 latency',
		kind: 'derived',
		unit: 'ms',
		expression: weighted('duration_p50_ms'),
		description: 'Request-weighted mean of per-minute medians',
	},
	{
		name: 'duration_p95_ms',
		label: 'p95 latency',
		kind: 'derived',
		unit: 'ms',
		expression: weighted('duration_p95_ms'),
		description: 'Request-weighted mean of per-minute p95s',
	},
	{
		name: 'error_rate',
		label: 'Server error rate',
		kind: 'derived',
		unit: 'percentunit',
		expression: 'if(sum(requests) = 0, 0, sum(status_5xx) / sum(requests))',
		description: '5xx responses / requests',
	},
	{
		name: 'client_error_rate',
		label: 'Client error rate',
		kind: 'derived',
		unit: 'percentunit',
		expression: 'if(sum(requests) = 0, 0, sum(status_4xx) / sum(requests))',
		description: '4xx responses / requests',
	},
	{
		name: 'success_rate',
		label: 'Success rate',
		kind: 'derived',
		unit: 'percentunit',
		expression: 'if(sum(requests) = 0, 1, (sum(status_2xx) + sum(status_3xx)) / sum(requests))',
		description: '2xx and 3xx responses / requests',
	},
	{
		name: 'avg_response_bytes',
		label: 'Average response size',
		kind: 'derived',
		unit: 'bytes',
		expression: 'if(sum(requests) = 0, 0, sum(bytes) / sum(requests))',
	},
];

const dbMeasures: MeasureDef[] = [
	{ name: 'up', label: 'Up (availability)', kind: 'gauge', unit: 'percentunit' },
	{ name: 'size_bytes', label: 'Size', kind: 'gauge', unit: 'bytes' },
	{ name: 'connections_active', label: 'Active connections', kind: 'gauge', unit: 'short' },
	{ name: 'connections_idle', label: 'Idle connections', kind: 'gauge', unit: 'short' },
	{ name: 'connections_total', label: 'Open connections', kind: 'gauge', unit: 'short' },
	{ name: 'max_connections', label: 'max_connections', kind: 'gauge', unit: 'short' },
	{ name: 'memory_bytes', label: 'Memory', kind: 'gauge', unit: 'bytes' },
	{ name: 'pooler_up', label: 'Pooler up', kind: 'gauge', unit: 'percentunit' },
	{ name: 'pool_active', label: 'Pool active', kind: 'gauge', unit: 'short' },
	{ name: 'pool_idle', label: 'Pool idle', kind: 'gauge', unit: 'short' },
	{ name: 'pool_waiting', label: 'Pool waiting clients', kind: 'gauge', unit: 'short' },
	{ name: 'pool_saturation', label: 'Pool saturation', kind: 'gauge', unit: 'percentunit' },
	{ name: 'pool_avg_wait_ms', label: 'Pool average wait', kind: 'gauge', unit: 'ms' },
	{ name: 'xact_commit', label: 'Commits', kind: 'counter', unit: 'short' },
	{ name: 'xact_rollback', label: 'Rollbacks', kind: 'counter', unit: 'short' },
	{ name: 'tup_returned', label: 'Rows returned', kind: 'counter', unit: 'short' },
	{ name: 'tup_fetched', label: 'Rows fetched', kind: 'counter', unit: 'short' },
	{ name: 'tup_inserted', label: 'Rows inserted', kind: 'counter', unit: 'short' },
	{ name: 'tup_updated', label: 'Rows updated', kind: 'counter', unit: 'short' },
	{ name: 'tup_deleted', label: 'Rows deleted', kind: 'counter', unit: 'short' },
	{ name: 'blks_hit', label: 'Buffer hits', kind: 'counter', unit: 'short' },
	{ name: 'blks_read', label: 'Blocks read', kind: 'counter', unit: 'short' },
	{ name: 'deadlocks', label: 'Deadlocks', kind: 'counter', unit: 'short' },
	{ name: 'temp_bytes', label: 'Temp file bytes', kind: 'counter', unit: 'bytes' },
	{
		name: 'cache_hit_ratio',
		label: 'Cache hit ratio',
		kind: 'derived',
		unit: 'percentunit',
		expression: 'if(sum(blks_hit) + sum(blks_read) = 0, 1, sum(blks_hit) / (sum(blks_hit) + sum(blks_read)))',
		description: 'blks_hit / (blks_hit + blks_read)',
	},
	{
		name: 'connection_utilization',
		label: 'Connection utilization',
		kind: 'derived',
		unit: 'percentunit',
		expression: 'if(max(max_connections) = 0, 0, avg(connections_total) / max(max_connections))',
		description: 'Open connections / max_connections',
	},
	{
		name: 'rollback_ratio',
		label: 'Rollback ratio',
		kind: 'derived',
		unit: 'percentunit',
		expression: 'if(sum(xact_commit) + sum(xact_rollback) = 0, 0, sum(xact_rollback) / (sum(xact_commit) + sum(xact_rollback)))',
	},
];

const storageMeasures: MeasureDef[] = [
	{ name: 'up', label: 'Up (availability)', kind: 'gauge', unit: 'percentunit' },
	{ name: 'used_bytes', label: 'Used', kind: 'gauge', unit: 'bytes' },
	{ name: 'objects', label: 'Objects', kind: 'gauge', unit: 'short' },
	{ name: 'bucket_count', label: 'Buckets', kind: 'gauge', unit: 'short' },
	{ name: 'memory_bytes', label: 'Memory', kind: 'gauge', unit: 'bytes' },
];

const trafficDimensions = [
	{ name: 'host', label: 'Host' },
	{ name: 'project_id', label: 'Project', idOf: 'project' as const },
];

export const DATASETS: Record<ObservabilityDataset, DatasetDef> = {
	traffic: {
		info: {
			name: 'traffic',
			label: 'HTTP traffic',
			description: 'Requests, status classes, bytes and latency per host, from the edge agents.',
			dimensions: trafficDimensions,
			tables: { minute: 'traffic_1m', hour: 'traffic_hourly' },
		},
		family: 'traffic',
		scope: 'project_id',
		measures: trafficMeasures,
	},
	traffic_paths: {
		info: {
			name: 'traffic_paths',
			label: 'Top paths',
			description: 'Request counts for the busiest paths (each agent keeps the top 10 per host and minute).',
			dimensions: [...trafficDimensions, { name: 'path', label: 'Path' }],
			tables: { minute: 'traffic_1m', hour: 'traffic_hourly' },
		},
		family: 'traffic',
		scope: 'project_id',
		mapColumn: { column: 'top_paths', key: 'path' },
		measures: [{ name: 'hits', label: 'Hits', kind: 'counter', unit: 'short', column: 'map_count' }],
	},
	traffic_referrers: {
		info: {
			name: 'traffic_referrers',
			label: 'Top referrers',
			description: 'Request counts for the top referrers (top 10 per host and minute).',
			dimensions: [...trafficDimensions, { name: 'referrer', label: 'Referrer' }],
			tables: { minute: 'traffic_1m', hour: 'traffic_hourly' },
		},
		family: 'traffic',
		scope: 'project_id',
		mapColumn: { column: 'top_referrers', key: 'referrer' },
		measures: [{ name: 'hits', label: 'Hits', kind: 'counter', unit: 'short', column: 'map_count' }],
	},
	databases: {
		info: {
			name: 'databases',
			label: 'Managed databases',
			description: 'Per-minute samples from each managed database: size, connections, pooler and pg_stat_database counters.',
			dimensions: [{ name: 'database_id', label: 'Database', idOf: 'database' }],
			tables: { minute: 'db_metrics_1m', hour: 'db_metrics_hourly' },
		},
		family: 'db_metrics',
		scope: 'database_id',
		measures: dbMeasures,
	},
	storage: {
		info: {
			name: 'storage',
			label: 'Object storage',
			description: 'Per-minute samples from each managed storage instance.',
			dimensions: [{ name: 'storage_id', label: 'Storage instance', idOf: 'storage' }],
			tables: { minute: 'storage_metrics_1m', hour: 'storage_metrics_hourly' },
		},
		family: 'storage_metrics',
		scope: 'storage_id',
		measures: storageMeasures,
	},
};

export function datasetCatalog(): DatasetInfo[] {
	return Object.values(DATASETS).map((def) => ({
		...def.info,
		measures: def.measures.map(({ name, label, kind, unit, description }) => ({ name, label, kind, unit, ...(description ? { description } : {}) })),
	}));
}

export interface CompileContext {
	database: string;
	fromMs: number;
	toMs: number;
	maxDataPoints: number;
	variables: QueryVariables;
	/** Ids the caller may see for the dataset's scope column; null = unrestricted. */
	scope: string[] | null;
	/** How far back minute rows are kept, hours. */
	minuteRetentionHours: number;
	/** The current time (minute data availability). */
	nowMs: number;
}

export interface CompiledQuery {
	sql: string;
	params: Record<string, string | number | string[]>;
	intervalSeconds: number;
	resolution: '1m' | '1h';
	notice?: string;
}

function chDateTime(ms: number): string {
	return new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/** Pick a bucket width from the range and the target point count. */
export function autoInterval(rangeSeconds: number, maxDataPoints: number, minimum: number): number {
	const wanted = Math.max(minimum, rangeSeconds / Math.max(1, maxDataPoints));
	return NICE_STEPS.find((step) => step >= wanted) ?? Math.ceil(wanted / 86_400) * 86_400;
}

const VARIABLE = /^\$(?:\{([a-z][a-z0-9_]*)\}|([a-z][a-z0-9_]*))$/;

/** Resolve a `$name` / `${name}` filter value; non-references pass through. */
function resolveValue(value: BuilderFilter['value'], variables: QueryVariables): string | number | string[] | null {
	if (typeof value !== 'string') return value;
	const match = VARIABLE.exec(value);
	if (!match) return value;
	const name = match[1] ?? match[2]!;
	if (!(name in variables)) return value;
	const resolved = variables[name]!;
	if (Array.isArray(resolved)) return resolved.includes('$__all') ? null : resolved;
	return resolved === '$__all' ? null : resolved;
}

function defaultAlias(metric: BuilderMetric, kind: FieldKind): string {
	if (kind === 'derived' || metric.agg === 'sum' || metric.agg === 'value') return metric.field;
	return `${metric.field}_${metric.agg}`;
}

function measureExpression(def: MeasureDef, agg: MetricAggregation, rateSeconds: number): string {
	if (def.kind === 'derived') return def.expression!;
	const column = def.column ?? def.name;
	switch (agg) {
		case 'sum':
		case 'value':
			return `sum(${column})`;
		case 'avg':
			return `avg(${column})`;
		case 'min':
			return `min(${column})`;
		case 'max':
			return `max(${column})`;
		case 'last':
			return `argMax(${column}, bucket)`;
		case 'count':
			return 'count()';
		case 'rate':
			return `sum(${column}) / ${rateSeconds}`;
	}
}

/**
 * Compile a builder spec to ClickHouse SQL. Throws `ValidationError` for names outside the
 * catalog; nothing the caller typed is ever placed in the SQL text except through parameters.
 */
export function compileBuilder(spec: BuilderSpec, ctx: CompileContext): CompiledQuery {
	const def = DATASETS[spec.dataset];
	if (!def) throw new ValidationError(`Unknown dataset ${spec.dataset}`);
	const dimensions = new Set(def.info.dimensions.map((dimension) => dimension.name));
	const measures = new Map(def.measures.map((measure) => [measure.name, measure]));
	if (spec.metrics.length === 0 && spec.groupBy.length === 0) throw new ValidationError('Pick at least one metric or group-by field.');
	for (const field of spec.groupBy) if (!dimensions.has(field)) throw new ValidationError(`${field} is not a dimension of ${spec.dataset}.`);
	for (const metric of spec.metrics) if (!measures.has(metric.field)) throw new ValidationError(`${metric.field} is not a measure of ${spec.dataset}.`);
	for (const filter of spec.filters) if (!dimensions.has(filter.field)) throw new ValidationError(`Filters apply to dimensions; ${filter.field} is not one of ${spec.dataset}.`);

	const rangeSeconds = Math.max(1, Math.floor((ctx.toMs - ctx.fromMs) / 1000));
	const minuteHorizon = ctx.nowMs - (ctx.minuteRetentionHours - 1) * HOUR_S * 1000;
	const fixed = spec.interval === 'auto' ? undefined : FIXED_INTERVALS[spec.interval];
	let notice: string | undefined;

	// Minute rows exist for the last ~48 h; anything older, or coarser than an hour, reads hourly.
	let resolution: '1m' | '1h' = ctx.fromMs >= minuteHorizon ? '1m' : '1h';
	let intervalSeconds = fixed ?? autoInterval(rangeSeconds, ctx.maxDataPoints, resolution === '1h' ? HOUR_S : MINUTE_S);
	if (intervalSeconds >= HOUR_S && intervalSeconds % HOUR_S === 0) resolution = '1h';
	if (resolution === '1h' && intervalSeconds < HOUR_S) {
		intervalSeconds = HOUR_S;
		notice = `Minute data is kept for ${ctx.minuteRetentionHours} h, so this range is shown in hourly buckets.`;
	}

	const db = ctx.database;
	const table = resolution === '1m' ? `${db}.${def.info.tables.minute}` : `${db}.${def.info.tables.hour}`;
	const params: CompiledQuery['params'] = {
		from: chDateTime(resolution === '1h' ? Math.floor(ctx.fromMs / (HOUR_S * 1000)) * HOUR_S * 1000 : ctx.fromMs),
		to: chDateTime(ctx.toMs),
	};

	const where = ["bucket >= {from:DateTime('UTC')}", "bucket <= {to:DateTime('UTC')}"];
	if (ctx.scope !== null) {
		if (ctx.scope.length === 0) where.push('0');
		else {
			where.push(`${def.scope} IN {scope:Array(String)}`);
			params.scope = ctx.scope;
		}
	}

	const columnFor = (field: string): string => (def.mapColumn && field === def.mapColumn.key ? 'map_key' : field);
	spec.filters.forEach((filter, index) => {
		const value = resolveValue(filter.value, ctx.variables);
		if (value === null) return;
		const name = `f${index}`;
		const column = columnFor(filter.field);
		const stringColumn = `toString(${column})`;
		const list = Array.isArray(value) ? value.map(String) : null;
		switch (filter.op) {
			case 'eq':
			case 'in':
				if (list) {
					params[name] = list;
					where.push(`${stringColumn} IN {${name}:Array(String)}`);
				} else {
					params[name] = String(value);
					where.push(`${stringColumn} = {${name}:String}`);
				}
				return;
			case 'neq':
			case 'nin':
				if (list) {
					params[name] = list;
					where.push(`${stringColumn} NOT IN {${name}:Array(String)}`);
				} else {
					params[name] = String(value);
					where.push(`${stringColumn} != {${name}:String}`);
				}
				return;
			case 'contains':
				params[name] = list ? (list[0] ?? '') : String(value);
				where.push(`positionCaseInsensitiveUTF8(${stringColumn}, {${name}:String}) > 0`);
				return;
			case 'gt':
			case 'gte':
			case 'lt':
			case 'lte': {
				const operator = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[filter.op];
				params[name] = list ? (list[0] ?? '') : String(value);
				where.push(`${stringColumn} ${operator} {${name}:String}`);
				return;
			}
		}
	});

	// Aggregates are computed under private `__mN` aliases and renamed by an outer query, so a
	// metric alias such as `requests` never shadows the column another aggregate reads.
	const inner: string[] = [];
	const outer: string[] = [];
	const groupBy: string[] = [];
	const timeSeries = spec.timeSeries && spec.metrics.length > 0;
	if (timeSeries) {
		inner.push(`toStartOfInterval(bucket, INTERVAL ${intervalSeconds} SECOND) AS __time`);
		outer.push('__time AS time');
		groupBy.push('__time');
	}
	spec.groupBy.forEach((field, index) => {
		inner.push(`${columnFor(field)} AS __d${index}`);
		outer.push(`__d${index} AS ${field}`);
		groupBy.push(`__d${index}`);
	});
	const aliases = new Set<string>(['time', ...spec.groupBy]);
	const metricAliases: string[] = [];
	const rateSeconds = timeSeries ? intervalSeconds : rangeSeconds;
	spec.metrics.forEach((metric, index) => {
		const measure = measures.get(metric.field)!;
		const base = metric.alias ?? defaultAlias(metric, measure.kind);
		let alias = base;
		for (let n = 2; aliases.has(alias); n++) alias = `${base}_${n}`;
		aliases.add(alias);
		metricAliases.push(alias);
		inner.push(`${measureExpression(measure, metric.agg, rateSeconds)} AS __m${index}`);
		outer.push(`__m${index} AS ${alias}`);
	});

	const from = def.mapColumn
		? `${table} ARRAY JOIN mapKeys(${def.mapColumn.column}) AS map_key, mapValues(${def.mapColumn.column}) AS map_count`
		: table;

	let orderBy: string;
	if (timeSeries) orderBy = ['time ASC', ...spec.groupBy.map((field) => `${field} ASC`)].join(', ');
	else if (spec.orderBy && aliases.has(spec.orderBy.field) && spec.orderBy.field !== 'time')
		orderBy = `${spec.orderBy.field} ${spec.orderBy.dir === 'asc' ? 'ASC' : 'DESC'}`;
	else if (metricAliases.length > 0) orderBy = `${metricAliases[0]} DESC`;
	else orderBy = spec.groupBy.map((field) => `${field} ASC`).join(', ');

	const limit = spec.limit ?? (timeSeries ? 10_000 : 1_000);
	const innerSql = [
		`SELECT ${inner.join(', ')}`,
		`FROM ${from}`,
		`WHERE ${where.join(' AND ')}`,
		groupBy.length > 0 ? `GROUP BY ${groupBy.join(', ')}` : '',
	]
		.filter(Boolean)
		.join('\n\t');
	const sql = `SELECT ${outer.join(', ')}\nFROM (\n\t${innerSql}\n)\nORDER BY ${orderBy}\nLIMIT ${Math.trunc(limit)}`;
	return { sql, params, intervalSeconds, resolution, ...(notice ? { notice } : {}) };
}

/** Render a variable value as SQL: a quoted string, or a tuple for `IN`. */
function variableSql(value: string | string[]): string {
	if (Array.isArray(value)) return value.length === 0 ? "('')" : `(${value.map((item) => quoteString(item)).join(', ')})`;
	return quoteString(value);
}

/**
 * Expand Grafana-style macros and `$variables` in admin SQL. Admin SQL runs as the read-only
 * reader, so this is convenience, not a security boundary.
 */
export function expandSqlMacros(
	sql: string,
	ctx: { fromMs: number; toMs: number; maxDataPoints: number; variables: QueryVariables; interval?: number },
): { sql: string; intervalSeconds: number } {
	const rangeSeconds = Math.max(1, Math.floor((ctx.toMs - ctx.fromMs) / 1000));
	const intervalSeconds = ctx.interval ?? autoInterval(rangeSeconds, ctx.maxDataPoints, MINUTE_S);
	const from = `toDateTime(${quoteString(chDateTime(ctx.fromMs))}, 'UTC')`;
	const to = `toDateTime(${quoteString(chDateTime(ctx.toMs))}, 'UTC')`;
	let out = sql
		.replace(/\$__timeFilter\(\s*([^)]+?)\s*\)/g, (_, column: string) => `(${column} >= ${from} AND ${column} <= ${to})`)
		.replace(/\$__timeInterval\(\s*([^)]+?)\s*\)/g, (_, column: string) => `toStartOfInterval(${column}, INTERVAL ${intervalSeconds} SECOND)`)
		.replace(/\$__fromTime\b/g, from)
		.replace(/\$__toTime\b/g, to)
		.replace(/\$__interval_s\b/g, String(intervalSeconds));
	out = out.replace(/\$\{([a-z][a-z0-9_]*)\}|\$([a-z][a-z0-9_]*)\b/g, (whole, braced: string | undefined, bare: string | undefined) => {
		const name = braced ?? bare!;
		const value = ctx.variables[name];
		return value === undefined ? whole : variableSql(value);
	});
	return { sql: out, intervalSeconds };
}

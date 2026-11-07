import * as z from 'zod';

/**
 * Observability dashboards (D101): user-built dashboards over the ClickHouse telemetry store.
 *
 * A panel runs one query. Builder queries are structured: the control plane turns them into SQL
 * and adds the caller's tenancy filter, so anyone with `metrics:read` can use them. SQL queries
 * run as written, as ClickHouse's read-only `skiff_reader` user with resource limits, and only
 * for platform admins (the reader sees every org's rows).
 *
 * Shared by the REST API (`/api/v1/observability/*`), the dashboard UI and the service layer.
 */

// --- builder catalog --------------------------------------------------------------------------

/** Builder datasets. Each maps to a `_1m`/`_1h` table pair; the server picks the resolution. */
export const observabilityDatasets = ['traffic', 'traffic_paths', 'traffic_referrers', 'databases', 'storage', 'brokers'] as const;
export type ObservabilityDataset = (typeof observabilityDatasets)[number];

/** `counter`: per-bucket deltas that sum. `gauge`: a sampled level. `derived`: a fixed formula. */
export type FieldKind = 'counter' | 'gauge' | 'derived';
export type FieldUnit = 'none' | 'short' | 'bytes' | 'ms' | 'percent' | 'percentunit' | 'reqps' | 'bytesps';

export interface DatasetMeasure {
	name: string;
	label: string;
	kind: FieldKind;
	unit: FieldUnit;
	description?: string;
}

export interface DatasetDimension {
	name: string;
	label: string;
	/** `project_id`, `database_id`, `storage_id` and `broker_id` values have display names in `names`. */
	idOf?: 'project' | 'database' | 'storage' | 'broker';
}

export interface DatasetInfo {
	name: ObservabilityDataset;
	label: string;
	description: string;
	measures: DatasetMeasure[];
	dimensions: DatasetDimension[];
	/** Tables behind the dataset, for SQL users. */
	tables: { minute: string; hour: string };
}

export const metricAggregations = ['sum', 'avg', 'min', 'max', 'last', 'rate', 'count', 'value'] as const;
export type MetricAggregation = (typeof metricAggregations)[number];

export const filterOperators = ['eq', 'neq', 'in', 'nin', 'contains', 'gt', 'gte', 'lt', 'lte'] as const;
export type FilterOperator = (typeof filterOperators)[number];

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'Use lower-case letters, digits and underscores');
/** Values may reference dashboard variables as `$name` or `${name}`. */
const filterValue = z.union([z.string().max(500), z.number(), z.array(z.string().max(500)).max(200)]);

export const builderMetricSchema = z.object({
	field: identifier,
	/** Ignored for derived fields. `count` counts buckets; `rate` is per second. */
	agg: z.enum(metricAggregations).default('sum'),
	alias: identifier.optional(),
});
export type BuilderMetric = z.infer<typeof builderMetricSchema>;

export const builderFilterSchema = z.object({
	field: identifier,
	op: z.enum(filterOperators),
	value: filterValue,
});
export type BuilderFilter = z.infer<typeof builderFilterSchema>;

/** Auto picks a bucket from the range and `maxDataPoints` (never finer than the data). */
export const builderIntervals = ['auto', '1m', '5m', '15m', '30m', '1h', '6h', '12h', '1d'] as const;
export type BuilderInterval = (typeof builderIntervals)[number];

export const builderSpecSchema = z.object({
	dataset: z.enum(observabilityDatasets),
	/** May be empty when `groupBy` is not: the query then lists distinct dimension values. */
	metrics: z.array(builderMetricSchema).max(12).default([]),
	groupBy: z.array(identifier).max(4).default([]),
	filters: z.array(builderFilterSchema).max(20).default([]),
	/** Bucket rows by time (a `time` column first). Off gives one row per group for the range. */
	timeSeries: z.boolean().default(true),
	interval: z.enum(builderIntervals).default('auto'),
	orderBy: z.object({ field: identifier, dir: z.enum(['asc', 'desc']).default('desc') }).optional(),
	limit: z.number().int().min(1).max(10_000).optional(),
});
export type BuilderSpec = z.infer<typeof builderSpecSchema>;

export const panelQuerySchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('builder'), builder: builderSpecSchema }),
	z.object({ mode: z.literal('sql'), sql: z.string().min(1).max(20_000) }),
]);
export type PanelQuery = z.infer<typeof panelQuerySchema>;

// --- running a query --------------------------------------------------------------------------

/** Variable values by name. A multi-value variable is an array; `$__all` means every value. */
export const queryVariablesSchema = z.record(z.string().max(64), z.union([z.string().max(500), z.array(z.string().max(500)).max(500)]));
export type QueryVariables = z.infer<typeof queryVariablesSchema>;

export const observabilityQueryRequestSchema = z.object({
	query: panelQuerySchema,
	/** Absolute ISO timestamps; the client resolves `now-6h` style ranges before sending. */
	range: z.object({ from: z.string(), to: z.string() }),
	/** Target points per series for `auto` intervals (usually the panel's width in pixels / 3). */
	maxDataPoints: z.number().int().min(10).max(5_000).default(500),
	variables: queryVariablesSchema.default({}),
});
export type ObservabilityQueryRequest = z.input<typeof observabilityQueryRequestSchema>;

/**
 * SQL macros (Grafana ClickHouse style), expanded before a SQL query runs:
 * `$__timeFilter(col)`, `$__fromTime`, `$__toTime`, `$__interval_s`, `$__timeInterval(col)`,
 * plus `$var` / `${var}` for dashboard variables (strings are quoted; multi-value becomes a
 * tuple `('a', 'b')` suitable for `IN`).
 */
export const sqlMacros = ['$__timeFilter', '$__fromTime', '$__toTime', '$__interval_s', '$__timeInterval'] as const;

export interface QueryColumn {
	name: string;
	/** ClickHouse type, e.g. `DateTime('UTC')`, `Float64`, `String`, `Nullable(String)`. */
	type: string;
	/** `time` columns carry epoch milliseconds; `number` columns are JS numbers. */
	kind: 'time' | 'number' | 'string' | 'other';
}

export interface QueryResult {
	columns: QueryColumn[];
	rows: Array<Array<string | number | boolean | null>>;
	/** The SQL that ran (builder output, or SQL after macro expansion). */
	sql: string;
	/** Bucket width the query used, seconds. */
	intervalSeconds: number;
	/** Which table resolution served a builder query. */
	resolution: '1m' | '1h' | null;
	stats: { elapsedMs: number; rowsRead: number; bytesRead: number };
	/** The server stopped at its row cap. */
	truncated: boolean;
	notice?: string;
}

// --- schema -----------------------------------------------------------------------------------

export interface ObservabilityTable {
	name: string;
	engine: string;
	rows: number;
	bytes: number;
	columns: Array<{ name: string; type: string; comment: string }>;
}

export interface ObservabilitySchema {
	/** The optional ClickHouse store is installed (D101). False is normal on a light install. */
	installed: boolean;
	/** ClickHouse reachable and its schema created. */
	available: boolean;
	/** Why it is not, when it is not. */
	error: string | null;
	/** The caller may run SQL queries (platform admins). */
	canUseSql: boolean;
	datasets: DatasetInfo[];
	/** Tables in the telemetry database; empty unless `canUseSql`. */
	tables: ObservabilityTable[];
	/** Display names for id dimensions the caller can see. */
	names: {
		project: Record<string, string>;
		database: Record<string, string>;
		storage: Record<string, string>;
		broker: Record<string, string>;
	};
	retention: { minuteHours: number; hourDays: number };
}

// --- dashboards -------------------------------------------------------------------------------

export const vizTypes = ['timeseries', 'bar', 'stat', 'gauge', 'bargauge', 'table', 'pie', 'text'] as const;
export type VizType = (typeof vizTypes)[number];

const thresholdSchema = z.object({ value: z.number().nullable(), color: z.string().max(32) });

export const panelOptionsSchema = z
	.object({
		unit: z.string().max(32).default('short'),
		decimals: z.number().int().min(0).max(10).nullable().default(null),
		min: z.number().nullable().default(null),
		max: z.number().nullable().default(null),
		/** Time series: line, area or stacked area; bars: grouped or stacked. */
		draw: z.enum(['line', 'area', 'stacked', 'points']).default('line'),
		legend: z.enum(['bottom', 'right', 'hidden']).default('bottom'),
		/** Stat/gauge: which value of a series to show. */
		reduce: z.enum(['last', 'mean', 'max', 'min', 'sum', 'first']).default('last'),
		/** Stat/gauge colours: the first value is null (base). Sorted ascending. */
		thresholds: z.array(thresholdSchema).max(10).default([]),
		/** Text panels: markdown body. */
		text: z.string().max(20_000).default(''),
		/** Series display overrides by series name. */
		seriesColors: z.record(z.string().max(200), z.string().max(32)).default({}),
	})
	.partial()
	.passthrough();
export type PanelOptions = z.infer<typeof panelOptionsSchema>;

export const gridPosSchema = z.object({
	x: z.number().int().min(0).max(23),
	y: z.number().int().min(0).max(10_000),
	w: z.number().int().min(1).max(24),
	h: z.number().int().min(1).max(100),
});
export type GridPos = z.infer<typeof gridPosSchema>;

/** 24-column grid like Grafana; a row is 30 px. */
export const DASHBOARD_GRID_COLUMNS = 24;
export const DASHBOARD_ROW_HEIGHT = 30;

export const dashboardPanelSchema = z.object({
	id: z.string().min(1).max(64),
	title: z.string().max(200).default(''),
	description: z.string().max(2_000).default(''),
	viz: z.enum(vizTypes),
	gridPos: gridPosSchema,
	/** Absent for text panels. */
	query: panelQuerySchema.optional(),
	options: panelOptionsSchema.default({}),
});
export type DashboardPanel = z.infer<typeof dashboardPanelSchema>;

export const dashboardVariableSchema = z.object({
	name: identifier,
	label: z.string().max(100).default(''),
	/** `query`: values are the first column of a query. `custom`: comma-separated list. */
	kind: z.enum(['query', 'custom', 'textbox']),
	query: panelQuerySchema.optional(),
	custom: z.string().max(5_000).default(''),
	multi: z.boolean().default(false),
	includeAll: z.boolean().default(false),
	/** Selected values; `['$__all']` selects everything. */
	current: z.array(z.string().max(500)).max(500).default([]),
});
export type DashboardVariable = z.infer<typeof dashboardVariableSchema>;

/** `now`, `now-6h`, `now-7d`, `now/d` style or an ISO timestamp. */
const timeExpr = z.string().min(1).max(64);

export const dashboardSpecSchema = z.object({
	schemaVersion: z.literal(1).default(1),
	time: z.object({ from: timeExpr, to: timeExpr }).default({ from: 'now-6h', to: 'now' }),
	/** Auto refresh: `10s`, `30s`, `1m`, `5m`, `15m`, `1h`, or null for off. */
	refresh: z.string().max(8).nullable().default(null),
	variables: z.array(dashboardVariableSchema).max(20).default([]),
	panels: z.array(dashboardPanelSchema).max(100).default([]),
});
export type DashboardSpec = z.infer<typeof dashboardSpecSchema>;

export const dashboardCreateSchema = z.object({
	title: z.string().trim().min(1).max(120),
	description: z.string().max(1_000).default(''),
	tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
	spec: dashboardSpecSchema.prefault({}),
});
export type DashboardCreateInput = z.input<typeof dashboardCreateSchema>;

export const dashboardUpdateSchema = z.object({
	title: z.string().trim().min(1).max(120).optional(),
	description: z.string().max(1_000).optional(),
	tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
	spec: dashboardSpecSchema.optional(),
	/** Optimistic concurrency: the `version` the edit was based on. A stale version is a 409. */
	version: z.number().int().min(1),
});
export type DashboardUpdateInput = z.input<typeof dashboardUpdateSchema>;

export interface DashboardSummary {
	id: string;
	title: string;
	description: string;
	tags: string[];
	panelCount: number;
	createdBy: string | null;
	createdByName: string | null;
	createdAt: string;
	updatedAt: string;
	version: number;
	/** The caller may edit or delete it. */
	canEdit: boolean;
	/** Some panel or variable uses SQL, which only platform admins can run. */
	usesSql: boolean;
}

export interface DashboardView extends DashboardSummary {
	spec: DashboardSpec;
}

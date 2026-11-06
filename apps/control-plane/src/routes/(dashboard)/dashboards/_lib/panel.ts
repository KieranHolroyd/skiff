import type {
	BuilderSpec,
	DashboardPanel,
	DashboardSpec,
	DatasetInfo,
	DatasetMeasure,
	FieldKind,
	MetricAggregation,
	ObservabilitySchema,
	PanelOptions,
	PanelQuery,
	VizType
} from '@skiff/contracts';
import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
import ChartBarIcon from '@lucide/svelte/icons/chart-bar';
import ChartLineIcon from '@lucide/svelte/icons/chart-line';
import ChartPieIcon from '@lucide/svelte/icons/chart-pie';
import GaugeIcon from '@lucide/svelte/icons/gauge';
import HashIcon from '@lucide/svelte/icons/hash';
import TableIcon from '@lucide/svelte/icons/table';
import TypeIcon from '@lucide/svelte/icons/type';
import type { Component } from 'svelte';

/** Panel options with every default filled in. */
export interface ResolvedOptions {
	unit: string;
	decimals: number | null;
	min: number | null;
	max: number | null;
	draw: 'line' | 'area' | 'stacked' | 'points';
	legend: 'bottom' | 'right' | 'hidden';
	reduce: 'last' | 'mean' | 'max' | 'min' | 'sum' | 'first';
	thresholds: Array<{ value: number | null; color: string }>;
	text: string;
	seriesColors: Record<string, string>;
}

export const DEFAULT_OPTIONS: ResolvedOptions = {
	unit: 'short',
	decimals: null,
	min: null,
	max: null,
	draw: 'line',
	legend: 'bottom',
	reduce: 'last',
	thresholds: [],
	text: '',
	seriesColors: {}
};

export function resolveOptions(options: PanelOptions | undefined): ResolvedOptions {
	return { ...DEFAULT_OPTIONS, ...(options ?? {}) } as ResolvedOptions;
}

export interface VizMeta {
	type: VizType;
	label: string;
	description: string;
	icon: Component<{ class?: string }>;
}

export const VIZ: VizMeta[] = [
	{
		type: 'timeseries',
		label: 'Time series',
		description: 'Lines or areas over time',
		icon: ChartLineIcon
	},
	{
		type: 'bar',
		label: 'Bar chart',
		description: 'Bars over time or by category',
		icon: ChartColumnIcon
	},
	{ type: 'stat', label: 'Stat', description: 'One big number with a sparkline', icon: HashIcon },
	{ type: 'gauge', label: 'Gauge', description: 'A value against min and max', icon: GaugeIcon },
	{
		type: 'bargauge',
		label: 'Bar gauge',
		description: 'Horizontal bars per series',
		icon: ChartBarIcon
	},
	{ type: 'table', label: 'Table', description: 'Rows and columns', icon: TableIcon },
	{ type: 'pie', label: 'Pie chart', description: 'Share of a whole', icon: ChartPieIcon },
	{ type: 'text', label: 'Text', description: 'Markdown notes', icon: TypeIcon }
];

export function vizMeta(type: VizType): VizMeta {
	return VIZ.find((viz) => viz.type === type) ?? VIZ[0]!;
}

/** Aggregations that make sense for a field kind; the first is the default. */
export function aggregationsFor(kind: FieldKind): MetricAggregation[] {
	switch (kind) {
		case 'counter':
			return ['sum', 'rate', 'avg', 'max', 'min', 'count'];
		case 'gauge':
			return ['avg', 'max', 'min', 'last'];
		case 'derived':
			return ['value'];
	}
}

export const AGG_LABELS: Record<MetricAggregation, string> = {
	sum: 'Sum',
	avg: 'Average',
	min: 'Min',
	max: 'Max',
	last: 'Last',
	rate: 'Rate /s',
	count: 'Count',
	value: 'Value'
};

/**
 * The result column a builder metric produces: its alias, else the field for `sum`, `value` and
 * derived fields, else `field_agg` (matches the server's builder).
 */
export function metricColumn(
	metric: { field: string; agg: MetricAggregation; alias?: string },
	dataset?: DatasetInfo
): string {
	if (metric.alias) return metric.alias;
	const kind = measureOf(dataset, metric.field)?.kind;
	if (kind === 'derived' || metric.agg === 'sum' || metric.agg === 'value') return metric.field;
	return `${metric.field}_${metric.agg}`;
}

export function measureOf(
	dataset: DatasetInfo | undefined,
	field: string
): DatasetMeasure | undefined {
	return dataset?.measures.find((measure) => measure.name === field);
}

/** A unit for a builder query's first metric (rates of bytes are bytes/s, of counts req/s). */
export function suggestedUnit(
	dataset: DatasetInfo | undefined,
	builder: BuilderSpec
): string | null {
	const metric = builder.metrics[0];
	if (!metric) return null;
	const measure = measureOf(dataset, metric.field);
	if (!measure) return null;
	if (metric.agg === 'rate') {
		if (measure.unit === 'bytes') return 'bytesps';
		return 'reqps';
	}
	if (metric.agg === 'count') return 'short';
	return measure.unit;
}

export function newId(): string {
	try {
		return crypto.randomUUID().slice(0, 8);
	} catch {
		return Math.random().toString(36).slice(2, 10);
	}
}

export function defaultBuilder(dataset?: DatasetInfo): BuilderSpec {
	const measure = dataset?.measures[0];
	return {
		dataset: dataset?.name ?? 'traffic',
		metrics: measure ? [{ field: measure.name, agg: aggregationsFor(measure.kind)[0]! }] : [],
		groupBy: [],
		filters: [],
		timeSeries: true,
		interval: 'auto'
	};
}

export function newPanel(
	viz: VizType,
	at: { x: number; y: number },
	dataset?: DatasetInfo
): DashboardPanel {
	const text = viz === 'text';
	const small = viz === 'stat' || viz === 'gauge';
	return {
		id: newId(),
		title: text ? '' : 'New panel',
		description: '',
		viz,
		gridPos: { x: at.x, y: at.y, w: small ? 6 : 12, h: text ? 4 : small ? 6 : 8 },
		query: text ? undefined : { mode: 'builder', builder: defaultBuilder(dataset) },
		options: text ? { text: '### Notes\n\nWrite **markdown** here.' } : {}
	};
}

/** Deep copy; works on `$state` proxies, and JSON is all a dashboard spec holds. */
export function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Each builder metric column's natural unit (bytes, ms, a rate…), so a table can format every
 * column correctly when the panel has no unit of its own.
 */
export function columnUnits(
	query: PanelQuery | undefined,
	schema: ObservabilitySchema | undefined
): Record<string, string> {
	if (query?.mode !== 'builder') return {};
	const dataset = schema?.datasets.find((item) => item.name === query.builder.dataset);
	const out: Record<string, string> = {};
	for (const metric of query.builder.metrics) {
		const unit = suggestedUnit(dataset, { ...query.builder, metrics: [metric] });
		if (unit) out[metricColumn(metric, dataset)] = unit;
	}
	return out;
}

/** Text that describes a query, for the panel header tooltip and history. */
export function querySummary(query: PanelQuery | undefined): string {
	if (!query) return '';
	if (query.mode === 'sql') return query.sql.trim().split('\n')[0]!.slice(0, 120);
	const { builder } = query;
	const metrics = builder.metrics.map((metric) => `${metric.agg}(${metric.field})`).join(', ');
	const by = builder.groupBy.length ? ` by ${builder.groupBy.join(', ')}` : '';
	return `${builder.dataset}: ${metrics || 'values'}${by}`;
}

const VARIABLE_DEFAULTS = {
	label: '',
	custom: '',
	multi: false,
	includeAll: false,
	current: [] as string[]
};
const PANEL_DEFAULTS = { title: '', description: '', options: {} as PanelOptions };

/** Fills defaults so older or hand-written JSON is safe to render. */
export function normalizeSpec(spec: Partial<DashboardSpec> | undefined): DashboardSpec {
	return {
		schemaVersion: 1,
		time: spec?.time ?? { from: 'now-1h', to: 'now' },
		refresh: spec?.refresh ?? null,
		variables: (spec?.variables ?? []).map((variable) => ({ ...VARIABLE_DEFAULTS, ...variable })),
		panels: (spec?.panels ?? []).map((panel) => ({
			...PANEL_DEFAULTS,
			...panel,
			id: panel.id || newId()
		}))
	};
}

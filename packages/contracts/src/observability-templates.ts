import * as z from 'zod';
import {
	DASHBOARD_GRID_COLUMNS,
	dashboardVariableSchema,
	panelOptionsSchema,
	panelQuerySchema,
	vizTypes,
	type BuilderSpec,
	type DashboardPanel,
	type GridPos,
	type VizType,
} from './observability.ts';

/**
 * Panel drafts, automatic layout and starter templates for observability dashboards (D101).
 *
 * A draft is a panel without a grid position: agents (MCP, the dashboard assistant) and the UI's
 * "new from template" describe *what* to show and `layoutPanels` decides *where*, so nobody has to
 * reason about a 24-column grid.
 */

export const panelSizes = ['quarter', 'third', 'half', 'two-thirds', 'full'] as const;
export type PanelSize = (typeof panelSizes)[number];

const SIZE_COLUMNS: Record<PanelSize, number> = { quarter: 6, third: 8, half: 12, 'two-thirds': 16, full: 24 };

const DEFAULTS: Record<VizType, { size: PanelSize; height: number }> = {
	stat: { size: 'quarter', height: 5 },
	gauge: { size: 'quarter', height: 6 },
	bargauge: { size: 'third', height: 8 },
	pie: { size: 'third', height: 8 },
	timeseries: { size: 'half', height: 8 },
	bar: { size: 'half', height: 8 },
	table: { size: 'half', height: 9 },
	text: { size: 'full', height: 3 },
};

export const panelDraftSchema = z
	.object({
		title: z.string().max(200).default(''),
		description: z.string().max(2_000).default(''),
		viz: z.enum(vizTypes).default('timeseries'),
		/** Required for every viz except `text`. */
		query: panelQuerySchema.optional(),
		/** Width on the dashboard; defaults by viz (stats a quarter, charts half, text full). */
		size: z.enum(panelSizes).optional(),
		/** Height in 30 px rows; defaults by viz. */
		height: z.number().int().min(2).max(40).optional(),
		/** Shorthand for `options.unit`: none, short, bytes, ms, percent, percentunit, reqps, bytesps. */
		unit: z.string().max(32).optional(),
		/** Shorthand for `options.text` (markdown) on text panels. */
		text: z.string().max(20_000).optional(),
		options: panelOptionsSchema.optional(),
	})
	.refine((draft) => draft.viz === 'text' || draft.query !== undefined, {
		message: 'Every panel except text needs a query',
		path: ['query'],
	});
export type PanelDraft = z.input<typeof panelDraftSchema>;

/** Where a sized panel goes: left to right, wrapping, below everything already on the grid. */
export function layoutPanels(
	existing: ReadonlyArray<GridPos>,
	drafts: ReadonlyArray<{ viz: VizType; size?: PanelSize; height?: number }>,
): GridPos[] {
	let y = existing.reduce((bottom, pos) => Math.max(bottom, pos.y + pos.h), 0);
	let x = 0;
	let rowHeight = 0;
	return drafts.map((draft) => {
		const w = SIZE_COLUMNS[draft.size ?? DEFAULTS[draft.viz].size];
		const h = draft.height ?? DEFAULTS[draft.viz].height;
		if (x + w > DASHBOARD_GRID_COLUMNS) {
			y += rowHeight;
			x = 0;
			rowHeight = 0;
		}
		const pos = { x, y, w, h };
		x += w;
		rowHeight = Math.max(rowHeight, h);
		return pos;
	});
}

/** Turn validated drafts into panels placed after `existing`. `newId` mints panel ids. */
export function panelsFromDrafts(
	existing: ReadonlyArray<Pick<DashboardPanel, 'gridPos'>>,
	drafts: ReadonlyArray<z.output<typeof panelDraftSchema>>,
	newId: () => string,
): DashboardPanel[] {
	const positions = layoutPanels(
		existing.map((panel) => panel.gridPos),
		drafts,
	);
	return drafts.map((draft, index) => ({
		id: newId(),
		title: draft.title,
		description: draft.description,
		viz: draft.viz,
		gridPos: positions[index]!,
		...(draft.query ? { query: draft.query } : {}),
		options: {
			...(draft.options ?? {}),
			...(draft.unit ? { unit: draft.unit } : {}),
			...(draft.text !== undefined ? { text: draft.text } : {}),
		},
	}));
}

// --- starter templates ------------------------------------------------------------------------

export const dashboardTemplateIds = ['traffic', 'databases', 'storage', 'brokers'] as const;
export type DashboardTemplateId = (typeof dashboardTemplateIds)[number];

export interface DashboardTemplate {
	id: DashboardTemplateId;
	title: string;
	description: string;
	tags: string[];
	time: { from: string; to: string };
	variables: Array<z.input<typeof dashboardVariableSchema>>;
	panels: PanelDraft[];
}

const builder = (spec: Partial<BuilderSpec> & Pick<BuilderSpec, 'dataset'>) => ({
	mode: 'builder' as const,
	builder: { metrics: [], groupBy: [], filters: [], timeSeries: true, interval: 'auto' as const, ...spec },
});

/** Traffic filters by the `host` variable (All by default). */
const hostFilter = [{ field: 'host', op: 'in' as const, value: '$host' }];

export const dashboardTemplates: Record<DashboardTemplateId, DashboardTemplate> = {
	traffic: {
		id: 'traffic',
		title: 'Traffic overview',
		description: 'Requests, errors, latency and bandwidth across your sites, with the busiest hosts, paths and referrers.',
		tags: ['traffic'],
		time: { from: 'now-24h', to: 'now' },
		variables: [
			{
				name: 'host',
				label: 'Host',
				kind: 'query',
				query: builder({ dataset: 'traffic', groupBy: ['host'], timeSeries: false }),
				multi: true,
				includeAll: true,
				current: ['$__all'],
			},
		],
		panels: [
			{ title: 'Requests', viz: 'stat', unit: 'short', query: builder({ dataset: 'traffic', metrics: [{ field: 'requests', agg: 'sum' }], filters: hostFilter }) },
			{
				title: 'Server error rate',
				viz: 'stat',
				unit: 'percentunit',
				options: { thresholds: [{ value: null, color: 'green' }, { value: 0.01, color: 'orange' }, { value: 0.05, color: 'red' }], reduce: 'mean' },
				query: builder({ dataset: 'traffic', metrics: [{ field: 'error_rate', agg: 'value' }], filters: hostFilter }),
			},
			{ title: 'p95 latency', viz: 'stat', unit: 'ms', options: { reduce: 'mean' }, query: builder({ dataset: 'traffic', metrics: [{ field: 'duration_p95_ms', agg: 'value' }], filters: hostFilter }) },
			{ title: 'Bandwidth', viz: 'stat', unit: 'bytes', options: { reduce: 'sum' }, query: builder({ dataset: 'traffic', metrics: [{ field: 'bytes', agg: 'sum' }], filters: hostFilter }) },
			{ title: 'Requests per second by host', viz: 'timeseries', unit: 'reqps', query: builder({ dataset: 'traffic', metrics: [{ field: 'requests', agg: 'rate' }], groupBy: ['host'], filters: hostFilter }) },
			{
				title: 'Responses by status class',
				viz: 'timeseries',
				unit: 'short',
				options: { draw: 'stacked' },
				query: builder({
					dataset: 'traffic',
					metrics: [
						{ field: 'status_2xx', agg: 'sum' },
						{ field: 'status_3xx', agg: 'sum' },
						{ field: 'status_4xx', agg: 'sum' },
						{ field: 'status_5xx', agg: 'sum' },
					],
					filters: hostFilter,
				}),
			},
			{
				title: 'Latency (p50 / p95)',
				viz: 'timeseries',
				unit: 'ms',
				query: builder({ dataset: 'traffic', metrics: [{ field: 'duration_p50_ms', agg: 'value' }, { field: 'duration_p95_ms', agg: 'value' }], filters: hostFilter }),
			},
			{ title: 'Bandwidth', viz: 'timeseries', unit: 'bytesps', query: builder({ dataset: 'traffic', metrics: [{ field: 'bytes', agg: 'rate' }], filters: hostFilter }) },
			{
				title: 'Busiest hosts',
				viz: 'table',
				size: 'third',
				query: builder({
					dataset: 'traffic',
					metrics: [{ field: 'requests', agg: 'sum' }, { field: 'error_rate', agg: 'value' }, { field: 'duration_p95_ms', agg: 'value' }],
					groupBy: ['host'],
					timeSeries: false,
					limit: 20,
				}),
			},
			{
				title: 'Top paths',
				viz: 'bargauge',
				query: builder({ dataset: 'traffic_paths', metrics: [{ field: 'hits', agg: 'sum' }], groupBy: ['path'], timeSeries: false, filters: hostFilter, limit: 10 }),
			},
			{
				title: 'Top referrers',
				viz: 'table',
				size: 'third',
				query: builder({ dataset: 'traffic_referrers', metrics: [{ field: 'hits', agg: 'sum' }], groupBy: ['referrer'], timeSeries: false, filters: hostFilter, limit: 10 }),
			},
			{
				title: 'Requests by project',
				viz: 'pie',
				size: 'half',
				query: builder({ dataset: 'traffic', metrics: [{ field: 'requests', agg: 'sum' }], groupBy: ['project_id'], timeSeries: false, limit: 12 }),
			},
		],
	},
	databases: {
		id: 'databases',
		title: 'Managed databases',
		description: 'Size, connections, throughput, cache hit ratio and pooler health for your managed databases.',
		tags: ['databases'],
		time: { from: 'now-24h', to: 'now' },
		variables: [
			{
				name: 'database',
				label: 'Database',
				kind: 'query',
				query: builder({ dataset: 'databases', groupBy: ['database_id'], timeSeries: false }),
				multi: true,
				includeAll: true,
				current: ['$__all'],
			},
		],
		panels: [
			{
				title: 'Availability',
				viz: 'stat',
				unit: 'percentunit',
				options: { reduce: 'mean', thresholds: [{ value: null, color: 'red' }, { value: 0.99, color: 'orange' }, { value: 0.999, color: 'green' }] },
				query: builder({ dataset: 'databases', metrics: [{ field: 'up', agg: 'avg' }], filters: [{ field: 'database_id', op: 'in', value: '$database' }] }),
			},
			{
				title: 'Cache hit ratio',
				viz: 'gauge',
				unit: 'percentunit',
				options: { min: 0, max: 1, reduce: 'mean', thresholds: [{ value: null, color: 'red' }, { value: 0.9, color: 'orange' }, { value: 0.99, color: 'green' }] },
				query: builder({ dataset: 'databases', metrics: [{ field: 'cache_hit_ratio', agg: 'value' }], filters: [{ field: 'database_id', op: 'in', value: '$database' }] }),
			},
			{
				title: 'Connection utilization',
				viz: 'gauge',
				unit: 'percentunit',
				options: { min: 0, max: 1, thresholds: [{ value: null, color: 'green' }, { value: 0.7, color: 'orange' }, { value: 0.9, color: 'red' }] },
				query: builder({ dataset: 'databases', metrics: [{ field: 'connection_utilization', agg: 'value' }], filters: [{ field: 'database_id', op: 'in', value: '$database' }] }),
			},
			{
				title: 'Pool saturation',
				viz: 'gauge',
				unit: 'percentunit',
				options: { min: 0, max: 1, thresholds: [{ value: null, color: 'green' }, { value: 0.7, color: 'orange' }, { value: 0.9, color: 'red' }] },
				query: builder({ dataset: 'databases', metrics: [{ field: 'pool_saturation', agg: 'max' }], filters: [{ field: 'database_id', op: 'in', value: '$database' }] }),
			},
			{
				title: 'Size',
				viz: 'timeseries',
				unit: 'bytes',
				query: builder({ dataset: 'databases', metrics: [{ field: 'size_bytes', agg: 'max' }], groupBy: ['database_id'], filters: [{ field: 'database_id', op: 'in', value: '$database' }] }),
			},
			{
				title: 'Connections',
				viz: 'timeseries',
				unit: 'short',
				query: builder({ dataset: 'databases', metrics: [{ field: 'connections_total', agg: 'avg' }], groupBy: ['database_id'], filters: [{ field: 'database_id', op: 'in', value: '$database' }] }),
			},
			{
				title: 'Transactions per second',
				viz: 'timeseries',
				unit: 'reqps',
				query: builder({
					dataset: 'databases',
					metrics: [{ field: 'xact_commit', agg: 'rate' }, { field: 'xact_rollback', agg: 'rate' }],
					filters: [{ field: 'database_id', op: 'in', value: '$database' }],
				}),
			},
			{
				title: 'Rows written per second',
				viz: 'timeseries',
				unit: 'short',
				options: { draw: 'stacked' },
				query: builder({
					dataset: 'databases',
					metrics: [{ field: 'tup_inserted', agg: 'rate' }, { field: 'tup_updated', agg: 'rate' }, { field: 'tup_deleted', agg: 'rate' }],
					filters: [{ field: 'database_id', op: 'in', value: '$database' }],
				}),
			},
		],
	},
	storage: {
		id: 'storage',
		title: 'Object storage',
		description: 'Used space, object counts and availability for your storage instances.',
		tags: ['storage'],
		time: { from: 'now-7d', to: 'now' },
		variables: [],
		panels: [
			{ title: 'Used', viz: 'stat', unit: 'bytes', query: builder({ dataset: 'storage', metrics: [{ field: 'used_bytes', agg: 'last' }], groupBy: ['storage_id'], timeSeries: false }) },
			{ title: 'Objects', viz: 'stat', unit: 'short', query: builder({ dataset: 'storage', metrics: [{ field: 'objects', agg: 'last' }], groupBy: ['storage_id'], timeSeries: false }) },
			{
				title: 'Availability',
				viz: 'stat',
				unit: 'percentunit',
				options: { reduce: 'mean' },
				query: builder({ dataset: 'storage', metrics: [{ field: 'up', agg: 'avg' }] }),
			},
			{ title: 'Buckets', viz: 'stat', unit: 'short', query: builder({ dataset: 'storage', metrics: [{ field: 'bucket_count', agg: 'last' }], timeSeries: false }) },
			{ title: 'Used space', viz: 'timeseries', unit: 'bytes', query: builder({ dataset: 'storage', metrics: [{ field: 'used_bytes', agg: 'max' }], groupBy: ['storage_id'] }) },
			{ title: 'Objects', viz: 'timeseries', unit: 'short', query: builder({ dataset: 'storage', metrics: [{ field: 'objects', agg: 'max' }], groupBy: ['storage_id'] }) },
		],
	},
	brokers: {
		id: 'brokers',
		title: 'Queue brokers',
		description: 'Backlog, throughput, store headroom and connections for your queue brokers (D123).',
		tags: ['queues'],
		time: { from: 'now-24h', to: 'now' },
		variables: [],
		panels: [
			{ title: 'Pending', viz: 'stat', unit: 'short', query: builder({ dataset: 'brokers', metrics: [{ field: 'pending', agg: 'last' }], timeSeries: false }) },
			{ title: 'Oldest message', viz: 'stat', unit: 'short', description: 'Seconds, across draining queues.', query: builder({ dataset: 'brokers', metrics: [{ field: 'oldest_age_seconds', agg: 'last' }], timeSeries: false }) },
			{ title: 'Store used', viz: 'gauge', unit: 'percentunit', query: builder({ dataset: 'brokers', metrics: [{ field: 'store_utilization', agg: 'max' }], groupBy: ['broker_id'], timeSeries: false }) },
			{
				title: 'Availability',
				viz: 'stat',
				unit: 'percentunit',
				options: { reduce: 'mean' },
				query: builder({ dataset: 'brokers', metrics: [{ field: 'up', agg: 'avg' }] }),
			},
			{ title: 'Backlog', viz: 'timeseries', unit: 'short', query: builder({ dataset: 'brokers', metrics: [{ field: 'pending', agg: 'max' }, { field: 'ack_pending', agg: 'max' }], groupBy: ['broker_id'] }) },
			{ title: 'Published', viz: 'timeseries', unit: 'short', description: 'Messages JetStream stored, per second.', query: builder({ dataset: 'brokers', metrics: [{ field: 'published', agg: 'rate' }], groupBy: ['broker_id'] }) },
			{ title: 'Messages in / out', viz: 'timeseries', unit: 'short', query: builder({ dataset: 'brokers', metrics: [{ field: 'messages_in', agg: 'rate' }, { field: 'messages_out', agg: 'rate' }] }) },
			{ title: 'Connections', viz: 'timeseries', unit: 'short', query: builder({ dataset: 'brokers', metrics: [{ field: 'connections', agg: 'avg' }], groupBy: ['broker_id'] }) },
		],
	},
};

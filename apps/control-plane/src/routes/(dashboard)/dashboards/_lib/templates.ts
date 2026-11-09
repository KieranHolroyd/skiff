import {
	dashboardSpecSchema,
	dashboardTemplates,
	dashboardVariableSchema,
	panelDraftSchema,
	panelsFromDrafts,
	type DashboardPanel,
	type DashboardSpec,
	type ObservabilitySchema
} from '@yoal/contracts';
import { compact } from './grid.js';
import { aggregationsFor, metricColumn, newId } from './panel.js';

/**
 * Starter dashboards. The definitions live in @yoal/contracts (`dashboardTemplates`), shared with
 * the agent tools (`create_dashboard` with a template), so the UI and agents create identical
 * dashboards. Builder queries only, so they work for every user (SQL is admin-only).
 * `fitTemplate` drops whatever the running server does not have, so a template never ships a
 * broken panel.
 */

export interface DashboardTemplate {
	id: string;
	title: string;
	description: string;
	tags: string[];
	spec: DashboardSpec;
}

export function templates(): DashboardTemplate[] {
	return Object.values(dashboardTemplates).map((template) => {
		const drafts = template.panels.map((draft) => panelDraftSchema.parse(draft));
		return {
			id: template.id,
			title: template.title,
			description: template.description,
			tags: template.tags,
			spec: dashboardSpecSchema.parse({
				time: template.time,
				variables: template.variables.map((variable) => dashboardVariableSchema.parse(variable)),
				panels: panelsFromDrafts([], drafts, newId)
			})
		};
	});
}

/**
 * A template adjusted to the server's catalog: unknown datasets, fields and dimensions are
 * removed, aggregations are fixed to ones the field kind allows, panels left with nothing to
 * query are dropped, and the layout is compacted. Without a schema the template is returned as is.
 */
export function fitTemplate(
	spec: DashboardSpec,
	schema: ObservabilitySchema | undefined
): DashboardSpec {
	if (!schema || schema.datasets.length === 0) return spec;
	const fitQuery = (query: DashboardPanel['query']): DashboardPanel['query'] | null => {
		if (!query || query.mode !== 'builder') return query ?? null;
		const dataset = schema.datasets.find((item) => item.name === query.builder.dataset);
		if (!dataset) return null;
		const measures = new Map(dataset.measures.map((measure) => [measure.name, measure]));
		const dims = new Set(dataset.dimensions.map((dimension) => dimension.name));
		const metrics = query.builder.metrics.flatMap((metric) => {
			const measure = measures.get(metric.field);
			if (!measure) return [];
			const allowed = aggregationsFor(measure.kind);
			return [{ ...metric, agg: allowed.includes(metric.agg) ? metric.agg : allowed[0]! }];
		});
		const groupBy = query.builder.groupBy.filter((name) => dims.has(name));
		if (metrics.length === 0 && (query.builder.metrics.length > 0 || groupBy.length === 0))
			return null;
		const filters = query.builder.filters.filter(
			(filter) => dims.has(filter.field) || measures.has(filter.field)
		);
		const names = new Set([
			...metrics.map((metric) => metricColumn(metric, dataset)),
			...groupBy,
			'time'
		]);
		const orderBy =
			query.builder.orderBy && names.has(query.builder.orderBy.field)
				? query.builder.orderBy
				: undefined;
		return { mode: 'builder', builder: { ...query.builder, metrics, groupBy, filters, orderBy } };
	};
	const panels = spec.panels.flatMap((item) => {
		if (item.viz === 'text') return [item];
		const query = fitQuery(item.query);
		return query ? [{ ...item, query }] : [];
	});
	const variables = spec.variables.filter(
		(item) => item.kind !== 'query' || fitQuery(item.query) !== null
	);
	const kept = new Set(variables.map((item) => item.name));
	// Filters on a variable that no longer exists would never match; drop them.
	for (const item of panels) {
		if (item.query?.mode !== 'builder') continue;
		item.query.builder.filters = item.query.builder.filters.filter((filter) => {
			const text = Array.isArray(filter.value) ? filter.value.join(',') : String(filter.value);
			const ref = /^\$\{?([a-z][a-z0-9_]*)/.exec(text);
			return !ref || kept.has(ref[1]!);
		});
	}
	const layout = compact(panels.map((item) => ({ id: item.id, ...item.gridPos })));
	const byId = new Map(layout.map((entry) => [entry.id, entry]));
	return {
		...spec,
		variables,
		panels: panels.map((item) => {
			const entry = byId.get(item.id)!;
			return { ...item, gridPos: { x: entry.x, y: entry.y, w: entry.w, h: entry.h } };
		})
	};
}

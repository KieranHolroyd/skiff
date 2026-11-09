import { browser } from '$app/env';
import type { ObservabilityQueryRequest, PanelQuery, QueryVariables } from '@yoal/contracts';
import { createQuery, keepPreviousData } from '@tanstack/svelte-query';
import { getSchema, keys, runQuery } from './api.js';
import type { ResolvedRange } from './time.js';
import { ALL } from './variables.js';

/** Only the variables a query mentions, so changing another variable does not refetch it. */
export function referencedVariables(
	query: PanelQuery | undefined,
	values: QueryVariables
): QueryVariables {
	if (!query) return {};
	const text = query.mode === 'sql' ? query.sql : JSON.stringify(query.builder);
	const out: QueryVariables = {};
	for (const [name, value] of Object.entries(values)) {
		if (!new RegExp(`\\$\\{?${name}\\b`).test(text)) continue;
		// Builder filters drop an "All" variable on the server, so the option list is not needed
		// (and loading it does not refetch the panel).
		out[name] =
			query.mode === 'builder' && Array.isArray(value) && value.includes(ALL) ? [ALL] : value;
	}
	return out;
}

/** Points per series for a panel this many pixels wide, rounded so small resizes keep the cache. */
export function maxDataPointsFor(width: number): number {
	const points = Math.round(Math.max(10, width) / 3 / 50) * 50;
	return Math.max(50, Math.min(5_000, points || 50));
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A filter whose value is still blank (just added in the editor) is left out rather than matching nothing. */
export function withoutEmptyFilters(query: PanelQuery): PanelQuery {
	if (query.mode !== 'builder') return query;
	const filters = query.builder.filters.filter((filter) =>
		Array.isArray(filter.value) ? filter.value.length > 0 : String(filter.value).trim() !== ''
	);
	return filters.length === query.builder.filters.length
		? query
		: { ...query, builder: { ...query.builder, filters } };
}

export function buildRequest(
	query: PanelQuery,
	range: ResolvedRange,
	width: number,
	variables: QueryVariables
): ObservabilityQueryRequest {
	return {
		query: withoutEmptyFilters(query),
		range: { from: iso(range.from), to: iso(range.to) },
		maxDataPoints: maxDataPointsFor(width),
		variables: referencedVariables(query, variables)
	};
}

/**
 * One panel's result, cached by everything that changes it: the query, the resolved range,
 * the variables it uses and its resolution. The previous result stays on screen while the next
 * one loads, so refreshes do not flash a skeleton.
 */
export function createPanelQuery(
	input: () => {
		query: PanelQuery | undefined;
		range: ResolvedRange | null;
		width: number;
		variables: QueryVariables;
		enabled?: boolean;
	}
) {
	// The shared (cached) schema: nothing is queried while the optional store is not installed.
	const schema = createSchemaQuery();
	return createQuery(() => {
		const { query, range, width, variables, enabled = true } = input();
		const installed = schema.data?.installed !== false;
		const request =
			query && range && width > 0 ? buildRequest(query, range, width, variables) : null;
		return {
			queryKey: request ? keys.query(request) : ['observability', 'query', 'idle'],
			// Superseded queries (every builder edit, refresh or resize makes a new key) are cancelled;
			// the server stops the ClickHouse query too and does not count it as an outage.
			queryFn: ({ signal }) => runQuery(request!, signal),
			enabled: browser && enabled && installed && request !== null,
			placeholderData: keepPreviousData,
			staleTime: 30_000,
			retry: false,
			refetchOnWindowFocus: false
		};
	});
}

/** The telemetry schema, shared by every page and panel through the query cache. */
export function createSchemaQuery() {
	return createQuery(() => ({
		queryKey: keys.schema,
		queryFn: ({ signal }) => getSchema(signal),
		staleTime: 60_000
	}));
}

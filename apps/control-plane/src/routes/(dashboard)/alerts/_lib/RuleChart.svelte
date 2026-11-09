<script lang="ts">
	/**
	 * The rule's metric over the last 6 hours, one line per series, with the threshold drawn as a
	 * dashed red rule. Runs the rule's builder query with time series on through the dashboards'
	 * query endpoint and draws it with the dashboards' time series panel.
	 */
	import type { AlertRuleSpec, ObservabilitySchema, QueryResult } from '@yoal/contracts';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { errorText } from '#lib/query.js';
	import { createPanelQuery } from '../../dashboards/_lib/panel-query.svelte.js';
	import PanelViz from '../../dashboards/_lib/viz/PanelViz.svelte';
	import { valueUnit } from './rules.js';

	let {
		rule,
		schema,
		hours = 6
	}: {
		rule: Pick<AlertRuleSpec, 'query' | 'condition' | 'variables' | 'name'>;
		schema: ObservabilitySchema | undefined;
		hours?: number;
	} = $props();

	let width = $state(0);
	// Fixed per mount so the query key (and cache) stays stable; the page refetches on focus.
	const to = Date.now();
	const range = $derived({ from: to - hours * 3_600_000, to });

	const chartQuery = $derived(
		rule.query.mode === 'builder'
			? {
					mode: 'builder' as const,
					builder: {
						...rule.query.builder,
						timeSeries: true,
						interval: 'auto' as const,
						limit: undefined
					}
				}
			: undefined
	);
	const data = createPanelQuery(() => ({
		query: chartQuery,
		range,
		width,
		variables: rule.variables
	}));
	const result = $derived(data.data as QueryResult | undefined);
	const unit = $derived(valueUnit(rule.query, schema?.datasets));

	/** Keep the threshold on screen even when every value is far below it. */
	const bounds = $derived.by(() => {
		let hi = Number.NEGATIVE_INFINITY;
		let lo = Number.POSITIVE_INFINITY;
		for (const row of result?.rows ?? []) {
			result!.columns.forEach((column, index) => {
				const cell = row[index];
				if (column.kind === 'number' && typeof cell === 'number' && Number.isFinite(cell)) {
					hi = Math.max(hi, cell);
					lo = Math.min(lo, cell);
				}
			});
		}
		const threshold = rule.condition.threshold;
		return {
			max: Number.isFinite(hi) && threshold > hi ? threshold * 1.15 || 1 : null,
			min: threshold < 0 && (!Number.isFinite(lo) || threshold < lo) ? threshold * 1.15 : null
		};
	});

	const panel = $derived({
		viz: 'timeseries' as const,
		title: `${rule.name} (last ${hours} h)`,
		options: {
			unit,
			min: bounds.min,
			max: bounds.max,
			legend: 'bottom' as const,
			thresholds: [
				{ value: null, color: 'green' },
				{ value: rule.condition.threshold, color: 'red' }
			]
		}
	});
</script>

<div class="h-72" bind:clientWidth={width}>
	{#if !chartQuery}
		<p class="grid size-full place-items-center px-4 text-center text-sm text-muted-foreground">
			SQL rules have no chart here: open the query in Explore to plot it.
		</p>
	{:else if schema?.installed === false}
		<p class="grid size-full place-items-center px-4 text-center text-sm text-muted-foreground">
			Telemetry is not installed, so there is no data to chart.
		</p>
	{:else if data.error && !result}
		<div
			class="flex size-full flex-col items-center justify-center gap-1.5 px-3 text-center"
			role="alert"
		>
			<CircleAlertIcon class="size-4 text-destructive" />
			<p class="max-w-md text-xs break-words text-destructive">
				{errorText(data.error, 'The chart query failed.')}
			</p>
		</div>
	{:else if !result}
		<Skeleton class="size-full rounded-md" />
	{:else if result.rows.length === 0}
		<p class="grid size-full place-items-center text-sm text-muted-foreground">
			No data in the last {hours} hours
		</p>
	{:else}
		<PanelViz {panel} {result} names={schema?.names} {range} />
	{/if}
</div>

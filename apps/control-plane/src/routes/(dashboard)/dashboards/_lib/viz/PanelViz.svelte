<script lang="ts">
	/**
	 * Draws one panel's result in its visualisation: pivots the rows into series, assigns colours,
	 * owns the legend (and which series it hides), and sizes the chart to the space left over.
	 */
	import type { DashboardPanel, QueryResult } from '@yoal/contracts';
	import Markdown from '#lib/assistant/Markdown.svelte';
	import { resolveOptions } from '../panel.js';
	import { toFrame, toItems, type Names } from '../series.js';
	import type { ResolvedRange } from '../time.js';
	import { formatValue, seriesColor } from '../units.js';
	import BarGaugeViz from './BarGaugeViz.svelte';
	import CategoryBarViz from './CategoryBarViz.svelte';
	import GaugeViz from './GaugeViz.svelte';
	import Legend from './Legend.svelte';
	import PieViz from './PieViz.svelte';
	import StatViz from './StatViz.svelte';
	import TableViz from './TableViz.svelte';
	import TimeSeriesViz from './TimeSeriesViz.svelte';

	let {
		panel,
		result,
		names,
		range,
		text = '',
		columnUnits,
		onzoom
	}: {
		panel: Pick<DashboardPanel, 'viz' | 'options' | 'title'>;
		result?: QueryResult;
		names?: Names;
		/** Null for text panels, which have no range. */
		range: ResolvedRange | null;
		/** Builder metric units by column, for tables without a panel unit. */
		columnUnits?: Record<string, string>;
		/** Text panels: markdown with variables already substituted. */
		text?: string;
		onzoom?: (from: number, to: number) => void;
	} = $props();

	const options = $derived(resolveOptions(panel.options));
	const frame = $derived(result ? toFrame(result, names) : null);
	const items = $derived(frame ? toItems(frame, options.reduce) : []);

	let hidden = $state(new Set<string>());

	/** Names in legend order: series for charts, items for pies and bar gauges. */
	const legendNames = $derived.by(() => {
		if (!frame) return [];
		if (panel.viz === 'pie' || panel.viz === 'bargauge') return items.map((item) => item.name);
		return frame.series.map((series) => series.name);
	});
	const colors = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- built fresh inside a derived
		const map = new Map<string, string>();
		const all = new Set([...legendNames, ...items.map((item) => item.name)]);
		[...all].forEach((name, index) =>
			map.set(name, seriesColor(index, name, options.seriesColors))
		);
		return map;
	});

	// Forget hidden series that no longer exist (new query, different groups).
	$effect(() => {
		const present = new Set(legendNames);
		if ([...hidden].some((name) => !present.has(name))) {
			hidden = new Set([...hidden].filter((name) => present.has(name)));
		}
	});

	function toggle(name: string, additive: boolean) {
		if (additive) {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced wholesale, never mutated in place
			const next = new Set(hidden);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			hidden = next;
			return;
		}
		const isolated = hidden.size === legendNames.length - 1 && !hidden.has(name);
		hidden = isolated ? new Set() : new Set(legendNames.filter((other) => other !== name));
	}

	const charted = $derived(
		panel.viz === 'timeseries' || panel.viz === 'bar' || panel.viz === 'pie'
	);
	const legend = $derived(
		charted && options.legend !== 'hidden' && legendNames.length > 1 ? options.legend : null
	);
	const legendItems = $derived(
		legendNames.map((name) => ({
			name,
			color: colors.get(name) ?? 'currentColor',
			value:
				panel.viz === 'pie'
					? formatValue(
							items.find((item) => item.name === name)?.value,
							options.unit,
							options.decimals
						)
					: legend === 'right' && frame?.kind === 'time'
						? formatValue(
								toItems(frame, options.reduce).find((item) => item.name === name)?.value,
								options.unit,
								options.decimals
							)
						: undefined
		}))
	);

	let height = $state(0);
	const chartHeight = $derived(Math.max(60, height));
	const label = $derived(panel.title || 'Panel');
</script>

{#if panel.viz === 'text'}
	<div class="size-full overflow-auto px-1 text-sm">
		<Markdown source={text} />
	</div>
{:else if result && frame}
	<div class="flex size-full min-h-0 gap-2 {legend === 'right' ? 'flex-row' : 'flex-col'}">
		<div class="relative min-h-0 min-w-0 flex-1" bind:clientHeight={height}>
			{#if height > 0}
				<div class="absolute inset-0">
					{#if panel.viz === 'table'}
						<TableViz
							{result}
							{options}
							{names}
							columnUnits={panel.options?.unit === undefined ? columnUnits : undefined}
							height={chartHeight}
						/>
					{:else if panel.viz === 'stat'}
						<StatViz {items} {options} height={chartHeight} {colors} />
					{:else if panel.viz === 'gauge'}
						<GaugeViz {items} {options} height={chartHeight} {colors} />
					{:else if panel.viz === 'bargauge'}
						<BarGaugeViz {items} {options} height={chartHeight} {colors} />
					{:else if panel.viz === 'pie'}
						<PieViz {items} {options} height={chartHeight} {colors} {hidden} />
					{:else if frame.kind === 'time' && range}
						<TimeSeriesViz
							{frame}
							{options}
							{range}
							intervalSeconds={result.intervalSeconds}
							height={chartHeight}
							{colors}
							{hidden}
							bars={panel.viz === 'bar'}
							{label}
							{onzoom}
						/>
					{:else if frame.kind === 'category'}
						<CategoryBarViz {frame} {options} height={chartHeight} {colors} {hidden} {label} />
					{/if}
				</div>
			{/if}
		</div>
		{#if legend}
			<Legend items={legendItems} {hidden} placement={legend} ontoggle={toggle} />
		{/if}
	</div>
{/if}

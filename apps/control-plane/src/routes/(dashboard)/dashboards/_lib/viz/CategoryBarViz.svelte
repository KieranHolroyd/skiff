<script lang="ts">
	/** Bars by category (no time column): one band per row, grouped or stacked by series. */
	import { barY, defineChart, group } from '@tanstack/charts';
	import { scaleBand } from '@tanstack/charts/scales/band';
	import { scaleLinear } from '@tanstack/charts/scales/linear';
	import { Chart } from '@tanstack/charts/svelte';
	import { tooltip } from '@tanstack/charts/tooltip';
	import { CHART_GRID, CHART_TOOLTIP_CLASS } from '#lib/charts.js';
	import type { ResolvedOptions } from '../panel.js';
	import type { CategoryFrame } from '../series.js';
	import { formatValue } from '../units.js';

	let {
		frame,
		options,
		height,
		colors,
		hidden,
		label
	}: {
		frame: CategoryFrame;
		options: ResolvedOptions;
		height: number;
		colors: Map<string, string>;
		hidden: Set<string>;
		label: string;
	} = $props();

	const visible = $derived(frame.series.filter((series) => !hidden.has(series.name)));
	const single = $derived(visible.length === 1);
	const format = (value: number) => formatValue(value, options.unit, options.decimals);

	const rows = $derived(
		visible.flatMap((series, which) =>
			frame.categories.map((category, index) => ({
				category,
				index,
				series: series.name,
				which,
				value: series.values[index] ?? 0,
				raw: series.values[index] ?? null
			}))
		)
	);
	const top = $derived.by(() => {
		if (options.draw === 'stacked') {
			const totals = frame.categories.map((_, index) =>
				visible.reduce((sum, series) => sum + Math.max(0, series.values[index] ?? 0), 0)
			);
			return Math.max(0, ...totals);
		}
		return Math.max(0, ...rows.map((row) => row.value));
	});
	const colorOf = (row: { series: string }) => colors.get(row.series) ?? 'currentColor';

	const definition = $derived(
		defineChart(
			{
				marks: [
					barY(rows, {
						id: 'bars',
						x: 'category',
						y: 'value',
						z: 'series',
						key: (row) => `${row.series}:${row.index}`,
						fill: colorOf,
						fillOpacity: 0.9,
						radius: { end: 3 },
						...(options.draw === 'stacked' || single ? {} : { layout: group({ padding: 0.1 }) })
					})
				],
				scales: {
					x: {
						scale: () => scaleBand<string>().domain(frame.categories).padding(0.2),
						axis: {
							line: { strokeOpacity: 0.25 },
							ticks: {
								size: 0,
								format: (value: string) => (value.length > 18 ? `${value.slice(0, 17)}…` : value)
							}
						}
					},
					y: {
						scale: scaleLinear().domain([
							options.min ?? 0,
							options.max ?? (top > 0 ? top * 1.1 : 1)
						]),
						grid: CHART_GRID,
						axis: {
							line: false,
							ticks: { size: 0, count: Math.max(2, Math.min(8, Math.floor(height / 60))), format }
						}
					}
				}
			},
			{
				focus: 'group-x',
				maxFocusDistance: Number.POSITIVE_INFINITY,
				tooltip: {
					use: tooltip,
					className: CHART_TOOLTIP_CLASS,
					content: (points) => ({
						title: points[0]?.datum.category ?? '',
						rows: points.map((point) => ({
							label: point.datum.series,
							value: formatValue(point.datum.raw, options.unit, options.decimals),
							color: colorOf(point.datum)
						}))
					})
				}
			}
		)
	);
</script>

<Chart {definition} ariaLabel={label} {height} initialWidth={640} class="text-muted-foreground" />

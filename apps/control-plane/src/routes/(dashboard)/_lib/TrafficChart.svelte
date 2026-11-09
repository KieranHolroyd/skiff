<script lang="ts">
	import type { TrafficSeriesPoint } from '@yoal/core';
	import { areaY, defineChart, lineY, rect } from '@tanstack/charts';
	import { crosshair } from '@tanstack/charts/crosshair';
	import { decorative } from '@tanstack/charts/mark/decorative';
	import { scaleLinear } from '@tanstack/charts/scales/linear';
	import { scaleUtc } from '@tanstack/charts/scales/time';
	import { Chart } from '@tanstack/charts/svelte';
	import { tooltip } from '@tanstack/charts/tooltip';
	import { CHART_GRID, CHART_TOOLTIP_CLASS, utcTimeFormat } from '#lib/charts.js';
	import { downsampleSeries } from './traffic-series.js';

	/**
	 * Traffic chart. Long series are merged into clock-aligned chart buckets (at most ~160 points)
	 * and plotted as an average rate per minute/hour, with 5xx errors overlaid as bars on the same
	 * scale.
	 */
	let {
		series,
		interval,
		class: className = ''
	}: { series: TrafficSeriesPoint[]; interval: '1m' | '1h'; class?: string } = $props();

	const chart = $derived(downsampleSeries(series, interval));
	const rows = $derived(
		chart.buckets.map((point) => {
			const start = new Date(point.start);
			const end = new Date(point.end);
			return { ...point, startAt: start, endAt: end, at: new Date((+start + +end) / 2) };
		})
	);
	const topRate = $derived(Math.max(0, ...rows.map((row) => row.requestRate)));
	// Bars fill the middle 60% of their bucket and keep a sliver of height, so a single error in a
	// busy hour is still visible.
	const errors = $derived(
		rows
			.filter((row) => row.status5xx > 0)
			.map((row) => {
				const pad = (+row.endAt - +row.startAt) * 0.2;
				return {
					...row,
					barStart: new Date(+row.startAt + pad),
					barEnd: new Date(+row.endAt - pad),
					barTop: Math.max(row.errorRate, topRate * 0.035)
				};
			})
	);

	const numberFormat = new Intl.NumberFormat('en-GB');
	const rateFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
	const compactFormat = new Intl.NumberFormat('en-GB', {
		notation: 'compact',
		maximumFractionDigits: 1
	});
	const timeFormatter = $derived(utcTimeFormat(interval));
	const rangeLabel = (row: { startAt: Date; endAt: Date }) =>
		chart.span === 1
			? `${timeFormatter.format(row.startAt)} UTC`
			: `${timeFormatter.format(row.startAt)}–${timeFormatter.format(row.endAt)} UTC`;
	const peakLabel = $derived(
		chart.peak >= 1000 ? `${(chart.peak / 1000).toFixed(1)}k` : String(Math.round(chart.peak))
	);

	const definition = $derived(
		defineChart(
			{
				marks: [
					decorative(
						areaY(rows, {
							id: 'requests-area',
							x: 'at',
							y1: 0,
							y2: 'requestRate',
							fill: 'var(--color-chart-1)',
							fillOpacity: 0.16
						})
					),
					decorative(
						rect(errors, {
							id: 'errors',
							x1: 'barStart',
							x2: 'barEnd',
							y1: () => 0,
							y2: 'barTop',
							fill: 'var(--color-destructive)',
							fillOpacity: 0.7
						})
					),
					lineY(rows, {
						id: 'requests',
						x: 'at',
						y: 'requestRate',
						key: 'start',
						stroke: 'var(--color-chart-1)',
						strokeWidth: 2
					}),
					crosshair({ x: true, y: false })
				],
				scales: {
					x: {
						scale:
							rows.length > 0
								? scaleUtc().domain([rows[0]!.startAt, rows.at(-1)!.endAt])
								: scaleUtc,
						axis: {
							line: { strokeOpacity: 0.25 },
							ticks: { size: 0, format: (value: Date) => timeFormatter.format(value) }
						}
					},
					y: {
						scale: scaleLinear,
						nice: 4,
						grid: CHART_GRID,
						axis: {
							line: false,
							ticks: { size: 0, count: 4, format: (value: number) => compactFormat.format(value) }
						}
					}
				}
			},
			{
				focus: 'nearest-x',
				maxFocusDistance: Number.POSITIVE_INFINITY,
				tooltip: {
					use: tooltip,
					className: CHART_TOOLTIP_CLASS,
					content: (points) => {
						const row = points[0]?.datum;
						if (!row) return { rows: [] };
						return {
							title: rangeLabel(row),
							rows: [
								{
									label: 'requests',
									value:
										chart.span > 1
											? `${numberFormat.format(row.requests)} · ${rateFormat.format(row.requestRate)}/${chart.unit} avg`
											: numberFormat.format(row.requests),
									color: 'var(--color-chart-1)'
								},
								{
									label: '5xx',
									value: numberFormat.format(row.status5xx),
									color: 'var(--color-destructive)'
								}
							]
						};
					}
				}
			}
		)
	);
</script>

<div class={className}>
	<div class="flex items-center justify-between gap-3 pb-2 text-xs text-muted-foreground">
		<span class="font-mono tabular-nums">
			peak {peakLabel}/{chart.unit}{#if chart.span > 1}
				· {chart.spanLabel} averages{/if}
		</span>
		<span class="flex items-center gap-3">
			<span class="flex items-center gap-1.5">
				<span class="size-2 rounded-[2px] bg-chart-1"></span>
				requests
			</span>
			<span class="flex items-center gap-1.5">
				<span class="size-2 rounded-[2px] bg-destructive"></span>
				5xx
			</span>
		</span>
	</div>
	<Chart
		{definition}
		ariaLabel={`Requests over time: ${numberFormat.format(chart.total)} total, peak ${peakLabel} per ${chart.unit === 'h' ? 'hour' : 'minute'}`}
		height={208}
		initialWidth={960}
		class="text-muted-foreground"
	/>
</div>

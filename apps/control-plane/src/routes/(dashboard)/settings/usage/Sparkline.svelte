<script lang="ts">
	/**
	 * A 30-day trend line for one usage meter, drawn with TanStack Charts. One series, so no
	 * legend: the row label names it. Hover or keyboard focus reads out a day's value; the daily
	 * table below is the accessible view.
	 */
	import { areaY, defineChart, dot, lineY } from '@tanstack/charts';
	import { crosshair } from '@tanstack/charts/crosshair';
	import { decorative } from '@tanstack/charts/mark/decorative';
	import { scaleLinear } from '@tanstack/charts/scales/linear';
	import { Chart } from '@tanstack/charts/svelte';
	import { tooltip } from '@tanstack/charts/tooltip';
	import { portal } from '@tanstack/charts/tooltip/portal';
	import { CHART_TOOLTIP_CLASS } from '#lib/charts.js';

	let {
		points,
		format,
		label,
		class: className = ''
	}: {
		points: Array<{ day: string; value: number }>;
		format: (value: number) => string;
		label: string;
		class?: string;
	} = $props();

	const rows = $derived(points.map((point, index) => ({ ...point, index })));
	const top = $derived(Math.max(0, ...points.map((point) => point.value)));

	const summary = $derived(
		points.length === 0
			? `${label}: no history yet`
			: `${label}: ${format(points[0]!.value)} on ${points[0]!.day}, ${format(points.at(-1)!.value)} on ${points.at(-1)!.day}`
	);

	function dayLabel(day: string): string {
		const date = new Date(`${day}T00:00:00Z`);
		return Number.isNaN(date.getTime())
			? day
			: date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
	}

	const definition = $derived(
		defineChart(
			{
				marks: [
					decorative(
						areaY(rows, {
							id: 'area',
							x: 'index',
							y1: 0,
							y2: 'value',
							fill: 'currentColor',
							fillOpacity: 0.12
						})
					),
					lineY(rows, {
						id: 'trend',
						x: 'index',
						y: 'value',
						key: 'day',
						stroke: 'currentColor',
						strokeWidth: 1.5
					}),
					// The latest value, so the line reads as "ending here" without hovering.
					decorative(
						dot(rows.slice(-1), {
							id: 'latest',
							x: 'index',
							y: 'value',
							r: 2.5,
							fill: 'currentColor'
						})
					),
					crosshair({ x: { strokeOpacity: 0.35 }, y: false })
				],
				scales: {
					x: { scale: scaleLinear().domain([0, Math.max(1, rows.length - 1)]), axis: false },
					y: { scale: scaleLinear().domain([0, top > 0 ? top : 1]), axis: false }
				},
				margin: 3
			},
			{
				focus: 'nearest-x',
				maxFocusDistance: Number.POSITIVE_INFINITY,
				tooltip: {
					use: tooltip,
					className: CHART_TOOLTIP_CLASS,
					// The chart is 96px wide inside a list row; lift the tooltip out of its clipping.
					portal,
					sticky: false,
					placement: ['top', 'bottom'],
					content: (focused) => {
						const point = focused[0]?.datum;
						return point
							? { rows: [{ label: dayLabel(point.day), value: format(point.value) }] }
							: { rows: [] };
					}
				}
			}
		)
	);
</script>

{#if points.length > 1}
	<Chart
		{definition}
		ariaLabel={summary}
		width={96}
		height={28}
		class="shrink-0 text-brand {className}"
	/>
{:else}
	<span class="block w-24 text-center text-xs text-muted-foreground {className}" title={summary}>
		—
	</span>
{/if}

<script lang="ts">
	/** A decorative trend under a stat value; the number above is the readable value. */
	import { areaY, defineChart, lineY } from '@tanstack/charts';
	import { decorative } from '@tanstack/charts/mark/decorative';
	import { scaleLinear } from '@tanstack/charts/scales/linear';
	import { Chart } from '@tanstack/charts/svelte';

	let { values, color, height }: { values: Array<number | null>; color: string; height: number } =
		$props();

	const rows = $derived(values.map((value, index) => ({ index, value })));
	const present = $derived(values.filter((value): value is number => value !== null));
	const lo = $derived(Math.min(0, ...present));
	const hi = $derived(Math.max(lo + 1e-9, ...present));

	const definition = $derived(
		defineChart(
			{
				marks: [
					decorative(
						areaY(rows, {
							id: 'fill',
							x: 'index',
							y1: lo,
							y2: 'value',
							fill: color,
							fillOpacity: 0.15
						})
					),
					decorative(
						lineY(rows, { id: 'line', x: 'index', y: 'value', stroke: color, strokeWidth: 1.5 })
					)
				],
				scales: {
					x: { scale: scaleLinear().domain([0, Math.max(1, rows.length - 1)]), axis: false },
					y: { scale: scaleLinear().domain([lo, hi * 1.05]), axis: false }
				},
				margin: 1
			},
			{ keyboard: false }
		)
	);
</script>

{#if present.length > 1}
	<div aria-hidden="true">
		<Chart {definition} ariaLabel="Trend" {height} initialWidth={200} tabIndex={-1} />
	</div>
{/if}

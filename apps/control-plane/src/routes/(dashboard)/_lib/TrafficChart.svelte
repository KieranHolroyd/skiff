<script lang="ts">
	import type { TrafficSeriesPoint } from '@skiff/core';
	import { downsampleSeries } from './traffic-series.js';

	/**
	 * Dependency-free traffic chart. Long series are merged into clock-aligned chart buckets
	 * (at most ~160 points) and plotted as an average rate per minute/hour, with 5xx errors
	 * overlaid as bars on the same scale.
	 */
	let {
		series,
		interval,
		class: className = ''
	}: { series: TrafficSeriesPoint[]; interval: '1m' | '1h'; class?: string } = $props();

	const WIDTH = 800;
	const HEIGHT = 200;

	const chart = $derived(downsampleSeries(series, interval));
	const buckets = $derived(chart.buckets);
	const top = $derived(Math.max(1e-9, ...buckets.map((point) => point.requestRate)));
	const step = $derived(buckets.length > 1 ? WIDTH / (buckets.length - 1) : WIDTH);
	const x = $derived((index: number) => (buckets.length > 1 ? index * step : WIDTH / 2));
	const y = $derived((value: number) => HEIGHT - (value / top) * HEIGHT);

	const areaPath = $derived.by(() => {
		if (buckets.length === 0) return '';
		const points = buckets.map((point, index) => `${x(index)},${y(point.requestRate)}`);
		return `M0,${HEIGHT} L${points.join(' L')} L${WIDTH},${HEIGHT} Z`;
	});
	const linePath = $derived.by(() => {
		if (buckets.length === 0) return '';
		return `M${buckets.map((point, index) => `${x(index)},${y(point.requestRate)}`).join(' L')}`;
	});
	const errorBars = $derived(
		buckets
			.map((point, index) => ({ point, index }))
			.filter(({ point }) => point.status5xx > 0)
			.map(({ point, index }) => ({
				x: x(index) - Math.max(step * 0.3, 0.6),
				width: Math.max(step * 0.6, 1.2),
				height: Math.max((point.errorRate / top) * HEIGHT, 1.2),
				point
			}))
	);

	const numberFormat = new Intl.NumberFormat('en-GB');
	const rateFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
	const timeFormatter = $derived(
		new Intl.DateTimeFormat('en-GB', {
			hour: '2-digit',
			minute: '2-digit',
			day: interval === '1h' ? '2-digit' : undefined,
			month: interval === '1h' ? 'short' : undefined,
			timeZone: 'UTC'
		})
	);
	const label = $derived((iso: string) => `${timeFormatter.format(new Date(iso))} UTC`);
	const rangeLabel = $derived((point: { start: string; end: string }) =>
		chart.span === 1
			? label(point.start)
			: `${timeFormatter.format(new Date(point.start))}–${label(point.end)}`
	);
	const tooltip = $derived((point: (typeof buckets)[number]) => {
		const rate =
			chart.span > 1 ? ` (${rateFormat.format(point.requestRate)}/${chart.unit} avg)` : '';
		return `${rangeLabel(point)}: ${numberFormat.format(point.requests)} requests${rate}, ${numberFormat.format(point.status5xx)} 5xx`;
	});
	const first = $derived(buckets[0] ? label(buckets[0].start) : '');
	const last = $derived(buckets.at(-1) ? label(buckets.at(-1)!.end) : '');
	const peakLabel = $derived(
		chart.peak >= 1000 ? `${(chart.peak / 1000).toFixed(1)}k` : String(Math.round(chart.peak))
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
	<svg
		viewBox="0 0 {WIDTH} {HEIGHT}"
		preserveAspectRatio="none"
		class="h-44 w-full overflow-visible"
		role="img"
		aria-label={`Requests over time: ${numberFormat.format(chart.total)} total, peak ${peakLabel} per ${chart.unit === 'h' ? 'hour' : 'minute'}`}
	>
		{#each [0.25, 0.5, 0.75] as fraction (fraction)}
			<line
				x1="0"
				x2={WIDTH}
				y1={HEIGHT * fraction}
				y2={HEIGHT * fraction}
				class="stroke-border"
				stroke-dasharray="3 5"
				stroke-width="1"
				vector-effect="non-scaling-stroke"
			/>
		{/each}
		<line
			x1="0"
			x2={WIDTH}
			y1={HEIGHT}
			y2={HEIGHT}
			class="stroke-border"
			stroke-width="1"
			vector-effect="non-scaling-stroke"
		/>
		<path d={areaPath} fill="var(--color-chart-1)" fill-opacity="0.16" />
		<path
			d={linePath}
			stroke="var(--color-chart-1)"
			fill="none"
			stroke-width="2"
			stroke-linejoin="round"
			vector-effect="non-scaling-stroke"
		/>
		{#each errorBars as bar (bar.point.start)}
			<rect
				x={bar.x}
				y={HEIGHT - bar.height}
				width={bar.width}
				height={bar.height}
				fill="var(--color-destructive)"
				fill-opacity="0.7"
			>
				<title>{rangeLabel(bar.point)}: {numberFormat.format(bar.point.status5xx)} 5xx</title>
			</rect>
		{/each}
		{#each buckets as point, index (point.start)}
			<rect
				x={x(index) - step / 2}
				y="0"
				width={Math.max(step, 0.5)}
				height={HEIGHT}
				fill="transparent"
			>
				<title>{tooltip(point)}</title>
			</rect>
		{/each}
	</svg>
	<div class="flex justify-between pt-1 font-mono text-xs text-muted-foreground">
		<span>{first}</span>
		<span>{last}</span>
	</div>
</div>

<script lang="ts">
	import type { TrafficSeriesPoint } from '@skiff/core';

	/**
	 * Dependency-free traffic chart. The series is summed down to at most ~160 points so a
	 * day of 1-minute buckets stays a light SVG, then drawn as an area for requests with
	 * 5xx errors overlaid as bars.
	 */
	let {
		series,
		interval,
		class: className = ''
	}: { series: TrafficSeriesPoint[]; interval: '1m' | '1h'; class?: string } = $props();

	const WIDTH = 800;
	const HEIGHT = 200;
	const MAX_POINTS = 160;

	const buckets = $derived.by(() => {
		if (series.length <= MAX_POINTS) return series;
		const size = Math.ceil(series.length / MAX_POINTS);
		const out: TrafficSeriesPoint[] = [];
		for (let index = 0; index < series.length; index += size) {
			const chunk = series.slice(index, index + size);
			const sum = (key: keyof TrafficSeriesPoint) =>
				chunk.reduce((total, point) => total + Number(point[key]), 0);
			out.push({
				bucket: chunk[0]!.bucket,
				requests: sum('requests'),
				bytes: sum('bytes'),
				status2xx: sum('status2xx'),
				status3xx: sum('status3xx'),
				status4xx: sum('status4xx'),
				status5xx: sum('status5xx'),
				durationP50Ms: chunk[0]!.durationP50Ms,
				durationP95Ms: Math.max(...chunk.map((point) => point.durationP95Ms))
			});
		}
		return out;
	});

	const peak = $derived(Math.max(1, ...buckets.map((point) => point.requests)));
	const total = $derived(buckets.reduce((sum, point) => sum + point.requests, 0));
	const step = $derived(buckets.length > 1 ? WIDTH / (buckets.length - 1) : WIDTH);
	const x = $derived((index: number) => (buckets.length > 1 ? index * step : WIDTH / 2));
	const y = $derived((value: number) => HEIGHT - (value / peak) * HEIGHT);

	const areaPath = $derived.by(() => {
		if (buckets.length === 0) return '';
		const points = buckets.map((point, index) => `${x(index)},${y(point.requests)}`);
		return `M0,${HEIGHT} L${points.join(' L')} L${WIDTH},${HEIGHT} Z`;
	});
	const linePath = $derived.by(() => {
		if (buckets.length === 0) return '';
		return `M${buckets.map((point, index) => `${x(index)},${y(point.requests)}`).join(' L')}`;
	});
	const errorBars = $derived(
		buckets
			.map((point, index) => ({ point, index }))
			.filter(({ point }) => point.status5xx > 0)
			.map(({ point, index }) => ({
				x: x(index) - Math.max(step * 0.3, 0.6),
				width: Math.max(step * 0.6, 1.2),
				height: Math.max((point.status5xx / peak) * HEIGHT, 1.2),
				point
			}))
	);

	const timeFormatter = $derived(
		new Intl.DateTimeFormat('en-GB', {
			hour: '2-digit',
			minute: '2-digit',
			day: interval === '1h' ? '2-digit' : undefined,
			month: interval === '1h' ? 'short' : undefined,
			timeZone: 'UTC'
		})
	);
	const label = $derived((bucket: string) => `${timeFormatter.format(new Date(bucket))} UTC`);
	const first = $derived(buckets[0] ? label(buckets[0].bucket) : '');
	const last = $derived(buckets.at(-1) ? label(buckets.at(-1)!.bucket) : '');
	const peakLabel = $derived(
		peak >= 1000 ? `${(peak / 1000).toFixed(1)}k` : String(Math.round(peak))
	);
</script>

<div class={className}>
	<div class="flex items-center justify-between gap-3 pb-2 text-[11px] text-muted-foreground">
		<span class="font-mono tabular-nums">peak {peakLabel}/bucket</span>
		<span class="flex items-center gap-3">
			<span class="flex items-center gap-1.5">
				<span class="size-2 rounded-[2px] bg-chart-1"></span>
				requests
			</span>
			<span class="flex items-center gap-1.5">
				<span class="size-2 rounded-[2px] bg-danger"></span>
				5xx
			</span>
		</span>
	</div>
	<svg
		viewBox="0 0 {WIDTH} {HEIGHT}"
		preserveAspectRatio="none"
		class="h-44 w-full overflow-visible"
		role="img"
		aria-label={`Requests over time: ${Math.round(total)} total, peak ${peakLabel} per bucket`}
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
		{#each errorBars as bar (bar.point.bucket)}
			<rect
				x={bar.x}
				y={HEIGHT - bar.height}
				width={bar.width}
				height={bar.height}
				fill="var(--color-danger)"
				fill-opacity="0.7"
			>
				<title>{label(bar.point.bucket)}: {bar.point.status5xx} 5xx</title>
			</rect>
		{/each}
		{#each buckets as point, index (point.bucket)}
			<rect
				x={x(index) - step / 2}
				y="0"
				width={Math.max(step, 0.5)}
				height={HEIGHT}
				fill="transparent"
			>
				<title>{label(point.bucket)}: {point.requests} requests, {point.status5xx} 5xx</title>
			</rect>
		{/each}
	</svg>
	<div class="flex justify-between pt-1 font-mono text-[11px] text-muted-foreground">
		<span>{first}</span>
		<span>{last}</span>
	</div>
</div>

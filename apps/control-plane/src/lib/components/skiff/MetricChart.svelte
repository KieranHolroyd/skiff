<script lang="ts">
	/**
	 * Multi-series line chart on a UTC time axis, drawn with TanStack Charts. Buckets sit at their
	 * real time inside `[from, to)`, so missing samples show as gaps instead of being squeezed
	 * out. An optional dashed reference line marks a limit (e.g. `max_connections`).
	 */
	import { areaY, defineChart, dot, lineY, ruleY } from '@tanstack/charts';
	import { crosshair } from '@tanstack/charts/crosshair';
	import { decorative } from '@tanstack/charts/mark/decorative';
	import { scaleLinear } from '@tanstack/charts/scales/linear';
	import { scaleUtc } from '@tanstack/charts/scales/time';
	import { Chart } from '@tanstack/charts/svelte';
	import { tooltip } from '@tanstack/charts/tooltip';
	import { CHART_GRID, CHART_TOOLTIP_CLASS, utcTimeFormat } from '#lib/charts.js';

	interface Series {
		label: string;
		/** CSS colour, usually a theme token such as `var(--color-chart-1)`. */
		color: string;
		values: Array<number | null>;
		/** Shade the area under the line. */
		fill?: boolean;
	}

	let {
		buckets,
		series,
		from,
		to,
		interval,
		format,
		reference = null,
		max,
		label,
		class: className = ''
	}: {
		buckets: Array<{ start: number; end: number }>;
		series: Series[];
		/** Epoch ms of the window start and end. */
		from: number;
		to: number;
		interval: '1m' | '1h';
		format: (value: number) => string;
		reference?: { label: string; value: number } | null;
		/** Fixed top of the y axis (e.g. 1 for ratios); otherwise the data maximum. */
		max?: number;
		/** Accessible description of the chart. */
		label: string;
		class?: string;
	} = $props();

	interface Row {
		series: string;
		at: Date;
		/** Plotted value, held at the top of a fixed axis. */
		value: number | null;
		/** The real sample, for the tooltip. */
		raw: number | null;
		bucket: number;
	}

	const dataTop = $derived(
		Math.max(
			0,
			...series.flatMap((item) =>
				item.values.filter((value): value is number => value !== null && Number.isFinite(value))
			)
		)
	);
	// Scale to the data so small values stay readable; the reference line is drawn only when it
	// falls inside that scale (i.e. when the data gets close to the limit).
	const top = $derived(max ?? (dataTop > 0 ? dataTop * 1.1 : 1));
	const referenceVisible = $derived(
		reference !== null && reference.value > 0 && reference.value <= top
	);

	/** A bucket continues the previous run when it starts within one bucket width of its end. */
	const joined = $derived(
		buckets.map((bucket, index) => {
			const previous = buckets[index - 1];
			if (!previous) return false;
			return bucket.start - previous.end <= Math.max(bucket.end - bucket.start, 1);
		})
	);

	/**
	 * One row per series and bucket, at the bucket midpoint. A null row is inserted wherever the
	 * buckets are not contiguous so the line breaks there instead of bridging the hole.
	 */
	// One Date per bucket, shared by every series, so all series sit at exactly the same x.
	const mids = $derived(
		buckets.map((bucket) => new Date(bucket.start + (bucket.end - bucket.start) / 2))
	);
	const gaps = $derived(
		buckets.map((_, index) => (index > 0 ? new Date(buckets[index - 1]!.end) : null))
	);

	const lines = $derived(
		series.map((item) => {
			const rows: Row[] = [];
			const lone: Row[] = [];
			let run: Row[] = [];
			const flush = () => {
				if (run.length === 1) lone.push(run[0]!);
				run = [];
			};
			buckets.forEach((_, index) => {
				const raw = item.values[index];
				const value = raw === null || raw === undefined || !Number.isFinite(raw) ? null : raw;
				if (index > 0 && !joined[index]) {
					rows.push({ series: item.label, at: gaps[index]!, value: null, raw: null, bucket: -1 });
					flush();
				}
				const row = {
					series: item.label,
					at: mids[index]!,
					value: value === null ? null : Math.min(value, top),
					raw: value,
					bucket: index
				};
				rows.push(row);
				if (row.value === null) flush();
				else run.push(row);
			});
			flush();
			return { item, rows, lone };
		})
	);

	const colorOf = (label: string) =>
		series.find((item) => item.label === label)?.color ?? 'currentColor';

	const timeFormatter = $derived(utcTimeFormat(interval));
	const when = (index: number) => {
		const bucket = buckets[index];
		if (!bucket) return '';
		const wide = bucket.end - bucket.start > (interval === '1h' ? 3_600_000 : 60_000);
		return wide
			? `${timeFormatter.format(new Date(bucket.start))}–${timeFormatter.format(new Date(bucket.end))} UTC`
			: `${timeFormatter.format(new Date(bucket.start))} UTC`;
	};

	const definition = $derived(
		defineChart(
			{
				marks: [
					...lines
						.filter((line) => line.item.fill)
						.map((line) =>
							decorative(
								areaY(line.rows, {
									id: `area-${line.item.label}`,
									x: 'at',
									y1: 0,
									y2: 'value',
									fill: line.item.color,
									fillOpacity: 0.14
								})
							)
						),
					...(reference && referenceVisible
						? [
								ruleY([reference.value], {
									id: 'reference',
									stroke: 'currentColor',
									strokeOpacity: 0.55,
									strokeDasharray: '6 4',
									strokeWidth: 1
								})
							]
						: []),
					// One mark for every series: grouped hover only gathers points within a mark.
					lineY(
						lines.flatMap((line) => line.rows),
						{
							id: 'lines',
							x: 'at',
							y: 'value',
							z: 'series',
							key: (row) => `${row.series}:${row.bucket}`,
							stroke: (row) => colorOf(row.series),
							strokeWidth: 2
						}
					),
					// A sample with no neighbours has no line segment; show it as a dot.
					...lines
						.filter((line) => line.lone.length > 0)
						.map((line) =>
							decorative(
								dot(line.lone, {
									id: `lone-${line.item.label}`,
									x: 'at',
									y: 'value',
									r: 2.5,
									fill: line.item.color
								})
							)
						),
					crosshair({ x: true, y: false })
				],
				scales: {
					x: {
						scale: scaleUtc().domain([new Date(from), new Date(to)]),
						axis: {
							line: { strokeOpacity: 0.25 },
							ticks: { size: 0, format: (value: Date) => timeFormatter.format(value) }
						}
					},
					y: {
						scale: scaleLinear().domain([0, top]),
						grid: CHART_GRID,
						axis: {
							line: false,
							ticks: { size: 0, count: 3, format: (value: number) => format(value) }
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
						title: when(points[0]?.datum.bucket ?? -1),
						rows: points.map((point) => ({
							label: point.datum.series,
							value: point.datum.raw === null ? '—' : format(point.datum.raw),
							color: colorOf(point.datum.series)
						}))
					})
				}
			}
		)
	);
</script>

<div class={className}>
	<div class="flex flex-wrap items-center justify-between gap-3 pb-2 text-xs text-muted-foreground">
		<span class="font-mono tabular-nums">max {format(dataTop)}</span>
		<span class="flex flex-wrap items-center gap-3">
			{#each series as item (item.label)}
				<span class="flex items-center gap-1.5">
					<span class="size-2 rounded-[2px]" style="background: {item.color}"></span>
					{item.label}
				</span>
			{/each}
			{#if reference}
				<span class="flex items-center gap-1.5">
					<span class="w-3 border-t border-dashed border-muted-foreground"></span>
					{reference.label}
					{format(reference.value)}
				</span>
			{/if}
		</span>
	</div>
	<Chart
		{definition}
		ariaLabel={label}
		height={168}
		initialWidth={720}
		class="text-muted-foreground"
	/>
</div>

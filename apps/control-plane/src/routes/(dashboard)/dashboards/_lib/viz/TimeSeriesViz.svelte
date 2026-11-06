<script lang="ts">
	/**
	 * Time series and time-bucketed bars on a UTC axis, drawn with TanStack Charts. Series share
	 * one line (or bar) mark so grouped hover shows every series at the hovered time; areas and
	 * lone-sample dots are decorative so they add no tooltip rows. Gaps longer than 1.5 buckets
	 * break the line. Dragging across the plot zooms the dashboard to that span.
	 */
	import { areaY, barY, defineChart, dot, group, lineY, ruleY } from '@tanstack/charts';
	import { crosshair } from '@tanstack/charts/crosshair';
	import { decorative } from '@tanstack/charts/mark/decorative';
	import { scaleBand } from '@tanstack/charts/scales/band';
	import { scaleLinear } from '@tanstack/charts/scales/linear';
	import { scaleUtc } from '@tanstack/charts/scales/time';
	import { Chart } from '@tanstack/charts/svelte';
	import { tooltip } from '@tanstack/charts/tooltip';
	import { CHART_GRID, CHART_TOOLTIP_CLASS } from '#lib/charts.js';
	import type { ResolvedOptions } from '../panel.js';
	import type { TimeFrame } from '../series.js';
	import { formatTimestamp, timeFormatter, type ResolvedRange } from '../time.js';
	import { cssColor, formatValue } from '../units.js';

	let {
		frame,
		options,
		range,
		intervalSeconds,
		height,
		colors,
		hidden,
		bars = false,
		label,
		onzoom
	}: {
		frame: TimeFrame;
		options: ResolvedOptions;
		range: ResolvedRange;
		intervalSeconds: number;
		height: number;
		colors: Map<string, string>;
		hidden: Set<string>;
		/** Draw buckets as bars instead of lines. */
		bars?: boolean;
		label: string;
		onzoom?: (from: number, to: number) => void;
	} = $props();

	interface Row {
		series: string;
		at: Date;
		t: number;
		/** Plotted top (stacked: cumulative). */
		value: number | null;
		/** Stacked bottom. */
		base: number;
		raw: number | null;
		index: number;
	}

	const visible = $derived(frame.series.filter((series) => !hidden.has(series.name)));
	const stacked = $derived(options.draw === 'stacked');
	const dates = $derived(frame.times.map((time) => new Date(time)));
	const gap = $derived(intervalSeconds > 0 ? intervalSeconds * 1_500 : Number.POSITIVE_INFINITY);
	const colorOf = (name: string) => colors.get(name) ?? 'currentColor';
	const format = (value: number) => formatValue(value, options.unit, options.decimals);

	const lines = $derived.by(() => {
		const bases = frame.times.map(() => 0);
		return visible.map((series) => {
			const rows: Row[] = [];
			const lone: Row[] = [];
			let run: Row[] = [];
			const flush = () => {
				if (run.length === 1) lone.push(run[0]!);
				run = [];
			};
			frame.times.forEach((time, index) => {
				const raw = series.values[index] ?? null;
				if (index > 0 && time - frame.times[index - 1]! > gap) {
					rows.push({
						series: series.name,
						at: new Date(frame.times[index - 1]! + 1),
						t: -1,
						value: null,
						base: 0,
						raw: null,
						index: -1
					});
					flush();
				}
				const base = stacked ? bases[index]! : 0;
				const value = raw === null ? null : stacked ? base + raw : raw;
				if (stacked && raw !== null) bases[index] = base + raw;
				const row = { series: series.name, at: dates[index]!, t: time, value, base, raw, index };
				rows.push(row);
				if (value === null) flush();
				else run.push(row);
			});
			flush();
			return { series, rows, lone };
		});
	});

	const extent = $derived.by(() => {
		let lo = Number.POSITIVE_INFINITY;
		let hi = Number.NEGATIVE_INFINITY;
		for (const line of lines) {
			for (const row of line.rows) {
				if (row.value === null) continue;
				lo = Math.min(lo, row.value, row.base);
				hi = Math.max(hi, row.value);
			}
		}
		if (!Number.isFinite(lo)) return { lo: 0, hi: 1 };
		const bottom = options.min ?? Math.min(0, lo);
		let top = options.max ?? (hi > 0 ? hi * 1.1 : hi < 0 ? 0 : 1);
		if (top <= bottom) top = bottom + 1;
		return { lo: bottom, hi: top };
	});

	const span = $derived(range.to - range.from);
	const ticks = $derived(timeFormatter(span));
	const thresholdLines = $derived(
		options.thresholds.filter(
			(step) => step.value !== null && step.value >= extent.lo && step.value <= extent.hi
		)
	);

	/** Bars: one band per bucket; label roughly every eighth. */
	const barTicks = $derived.by(() => {
		const every = Math.max(1, Math.ceil(frame.times.length / 8));
		return frame.times.filter((_, index) => index % every === 0);
	});

	const tooltipConfig = $derived({
		use: tooltip,
		className: CHART_TOOLTIP_CLASS,
		content: (points: ReadonlyArray<{ datum: Row }>) => ({
			title: formatTimestamp(points[0]?.datum.t ?? 0),
			rows: points
				.filter((point) => point.datum.raw !== null)
				.map((point) => ({
					label: point.datum.series,
					value: format(point.datum.raw!),
					color: colorOf(point.datum.series)
				}))
		})
	});

	const yScale = $derived({
		scale: scaleLinear().domain([extent.lo, extent.hi]),
		grid: CHART_GRID,
		axis: {
			line: false as const,
			ticks: { size: 0, count: Math.max(2, Math.min(8, Math.floor(height / 60))), format }
		}
	});

	const thresholdMarks = $derived(
		thresholdLines.map((step, index) =>
			decorative(
				ruleY([step.value!], {
					id: `threshold-${index}`,
					stroke: cssColor(step.color),
					strokeOpacity: 0.6,
					strokeDasharray: '4 4',
					strokeWidth: 1
				})
			)
		)
	);

	const lineDefinition = $derived(
		defineChart(
			{
				marks: [
					...(options.draw === 'area' || stacked
						? lines.map((line) =>
								decorative(
									areaY(line.rows, {
										id: `area-${line.series.name}`,
										x: 'at',
										y1: (row: Row) => (row.value === null ? null : row.base),
										y2: 'value',
										fill: colorOf(line.series.name),
										fillOpacity: stacked ? 0.3 : 0.14
									})
								)
							)
						: []),
					...thresholdMarks,
					options.draw === 'points'
						? dot(
								lines.flatMap((line) => line.rows.filter((row) => row.value !== null)),
								{
									id: 'points',
									x: 'at',
									y: 'value',
									z: 'series',
									r: 2.5,
									key: (row: Row) => `${row.series}:${row.index}`,
									color: 'series'
								}
							)
						: lineY(
								lines.flatMap((line) => line.rows),
								{
									id: 'lines',
									x: 'at',
									y: 'value',
									z: 'series',
									key: (row: Row) => `${row.series}:${row.index}`,
									stroke: (row: Row) => colorOf(row.series),
									strokeWidth: 1.75
								}
							),
					...(options.draw === 'points'
						? []
						: lines
								.filter((line) => line.lone.length > 0)
								.map((line) =>
									decorative(
										dot(line.lone, {
											id: `lone-${line.series.name}`,
											x: 'at',
											y: 'value',
											r: 2.5,
											fill: colorOf(line.series.name)
										})
									)
								)),
					crosshair({ x: true, y: false })
				],
				scales: {
					x: {
						scale: scaleUtc().domain([new Date(range.from), new Date(range.to)]),
						axis: {
							line: { strokeOpacity: 0.25 },
							ticks: { size: 0, format: (value: Date) => ticks.format(value) }
						}
					},
					y: yScale
				},
				// Dots take their colour from the colour scale (a dot's fill is a constant).
				color: {
					domain: visible.map((series) => series.name),
					range: visible.map((series) => colorOf(series.name))
				}
			},
			{ focus: 'group-x', maxFocusDistance: Number.POSITIVE_INFINITY, tooltip: tooltipConfig }
		)
	);

	const barRows = $derived(
		lines.flatMap((line) =>
			line.rows
				.filter((row) => row.index >= 0)
				.map((row) => ({ ...row, raw: row.raw, y: row.raw ?? 0 }))
		)
	);

	const barDefinition = $derived(
		defineChart(
			{
				marks: [
					barY(barRows, {
						id: 'bars',
						x: 't',
						y: 'y',
						z: 'series',
						key: (row) => `${row.series}:${row.index}`,
						fill: (row) => colorOf(row.series),
						fillOpacity: 0.85,
						...(stacked || visible.length === 1 ? {} : { layout: group({ padding: 0.1 }) })
					}),
					...thresholdMarks
				],
				scales: {
					x: {
						scale: () =>
							scaleBand<number>()
								.domain(frame.times)
								.padding(frame.times.length > 60 ? 0.05 : 0.2),
						axis: {
							line: { strokeOpacity: 0.25 },
							ticks: { size: 0, values: barTicks, format: (value: number) => ticks.format(value) }
						}
					},
					y: yScale
				}
			},
			{ focus: 'group-x', maxFocusDistance: Number.POSITIVE_INFINITY, tooltip: tooltipConfig }
		)
	);

	// --- drag to zoom ----------------------------------------------------------------------------

	let plot = { left: 0, width: 0, total: 0 };
	let host: HTMLDivElement | undefined = $state();
	let drag = $state<{ start: number; end: number } | null>(null);

	function onRender(context: { scene: { width: number; chart: { x: number; width: number } } }) {
		plot = {
			left: context.scene.chart.x,
			width: context.scene.chart.width,
			total: context.scene.width
		};
	}

	function fraction(event: PointerEvent): number {
		if (!host || plot.width <= 0) return 0;
		const box = host.getBoundingClientRect();
		const scale = box.width / (plot.total || box.width);
		return Math.max(
			0,
			Math.min(1, (event.clientX - box.left - plot.left * scale) / (plot.width * scale))
		);
	}

	function pointerDown(event: PointerEvent) {
		if (!onzoom || bars || event.button !== 0) return;
		drag = { start: fraction(event), end: fraction(event) };
		capture(event);
	}

	function pointerMove(event: PointerEvent) {
		if (drag) drag = { ...drag, end: fraction(event) };
	}

	function pointerUp() {
		if (!drag) return;
		const lo = Math.min(drag.start, drag.end);
		const hi = Math.max(drag.start, drag.end);
		drag = null;
		if (hi - lo < 0.01) return;
		onzoom?.(range.from + lo * span, range.from + hi * span);
	}

	const selection = $derived.by(() => {
		if (!drag || !host || plot.width <= 0) return null;
		const total = plot.total || 1;
		const lo = Math.min(drag.start, drag.end);
		const hi = Math.max(drag.start, drag.end);
		return {
			left: ((plot.left + lo * plot.width) / total) * 100,
			width: (((hi - lo) * plot.width) / total) * 100
		};
	});

	/** Keep receiving moves outside the element; fails harmlessly for pointers already gone. */
	function capture(event: PointerEvent) {
		try {
			(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		} catch {
			// The pointer was released before capture.
		}
	}
</script>

<div
	bind:this={host}
	class="relative select-none"
	role="presentation"
	onpointerdown={pointerDown}
	onpointermove={pointerMove}
	onpointerup={pointerUp}
	onpointercancel={() => (drag = null)}
>
	{#if bars}
		<Chart
			definition={barDefinition}
			ariaLabel={label}
			{height}
			initialWidth={640}
			class="text-muted-foreground"
			{onRender}
		/>
	{:else}
		<Chart
			definition={lineDefinition}
			ariaLabel={label}
			{height}
			initialWidth={640}
			class="text-muted-foreground"
			{onRender}
		/>
	{/if}
	{#if selection}
		<div
			class="pointer-events-none absolute inset-y-0 border-x border-brand/60 bg-brand/10"
			style:left="{selection.left}%"
			style:width="{selection.width}%"
		></div>
	{/if}
</div>

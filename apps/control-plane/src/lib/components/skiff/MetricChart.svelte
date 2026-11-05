<script lang="ts">
	/**
	 * Dependency-free multi-series line chart on a time axis, in the TrafficChart style. Buckets sit
	 * at their real time inside `[from, to)`, so missing samples show as gaps instead of being
	 * squeezed out. An optional dashed reference line marks a limit (e.g. `max_connections`).
	 */
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

	const WIDTH = 800;
	const HEIGHT = 160;

	const span = $derived(Math.max(1, to - from));
	const round = (value: number) => Math.round(value * 100) / 100;
	const x = $derived((ms: number) =>
		round(Math.min(WIDTH, Math.max(0, ((ms - from) / span) * WIDTH)))
	);
	const mid = (bucket: { start: number; end: number }) =>
		bucket.start + (bucket.end - bucket.start) / 2;

	const dataTop = $derived(
		Math.max(
			0,
			...series.flatMap((item) => item.values.filter((value): value is number => value !== null))
		)
	);
	// Scale to the data so small values stay readable; the reference line is drawn only when it
	// falls inside that scale (i.e. when the data gets close to the limit).
	const top = $derived(max ?? (dataTop > 0 ? dataTop * 1.1 : 1));
	const y = $derived((value: number) => round(HEIGHT - (Math.min(value, top) / top) * HEIGHT));
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

	const paths = $derived(
		series.map((item) => {
			const runs: Array<Array<[number, number]>> = [];
			let current: Array<[number, number]> | null = null;
			item.values.forEach((value, index) => {
				const bucket = buckets[index];
				if (!bucket || value === null || !Number.isFinite(value)) {
					current = null;
					return;
				}
				if (!current || !joined[index]) {
					current = [];
					runs.push(current);
				}
				current.push([x(mid(bucket)), y(value)]);
			});
			return {
				item,
				lines: runs
					.filter((run) => run.length > 1)
					.map((run) => `M${run.map(([px, py]) => `${px},${py}`).join(' L')}`),
				areas: item.fill
					? runs
							.filter((run) => run.length > 1)
							.map(
								(run) =>
									`M${run[0]![0]},${HEIGHT} L${run.map(([px, py]) => `${px},${py}`).join(' L')} L${run.at(-1)![0]},${HEIGHT} Z`
							)
					: [],
				dots: runs.filter((run) => run.length === 1).map((run) => run[0]!)
			};
		})
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
	const time = $derived((ms: number) => `${timeFormatter.format(new Date(ms))} UTC`);
	const tooltip = $derived((index: number) => {
		const bucket = buckets[index]!;
		const values = series
			.map((item) => {
				const value = item.values[index];
				return `${item.label} ${value === null || value === undefined ? '—' : format(value)}`;
			})
			.join(', ');
		const when =
			bucket.end - bucket.start > (interval === '1h' ? 3_600_000 : 60_000)
				? `${timeFormatter.format(new Date(bucket.start))}–${time(bucket.end)}`
				: time(bucket.start);
		return `${when}: ${values}`;
	});
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
	<svg
		viewBox="0 0 {WIDTH} {HEIGHT}"
		preserveAspectRatio="none"
		class="h-36 w-full overflow-visible"
		role="img"
		aria-label={label}
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
		{#if reference && referenceVisible}
			<line
				x1="0"
				x2={WIDTH}
				y1={y(reference.value)}
				y2={y(reference.value)}
				class="stroke-muted-foreground"
				stroke-dasharray="6 4"
				stroke-width="1"
				vector-effect="non-scaling-stroke"
			/>
		{/if}
		{#each paths as path (path.item.label)}
			{#each path.areas as area, index (index)}
				<path d={area} fill={path.item.color} fill-opacity="0.14" />
			{/each}
			{#each path.lines as line, index (index)}
				<path
					d={line}
					stroke={path.item.color}
					fill="none"
					stroke-width="2"
					stroke-linejoin="round"
					vector-effect="non-scaling-stroke"
				/>
			{/each}
			{#each path.dots as [cx, cy], index (index)}
				<line
					x1={cx}
					x2={cx}
					y1={cy}
					y2={cy}
					stroke={path.item.color}
					stroke-width="5"
					stroke-linecap="round"
					vector-effect="non-scaling-stroke"
				/>
			{/each}
		{/each}
		{#each buckets as bucket, index (bucket.start)}
			<rect
				x={x(bucket.start)}
				y="0"
				width={Math.max(x(bucket.end) - x(bucket.start), 0.5)}
				height={HEIGHT}
				fill="transparent"
			>
				<title>{tooltip(index)}</title>
			</rect>
		{/each}
	</svg>
	<div class="flex justify-between pt-1 font-mono text-xs text-muted-foreground">
		<span>{time(from)}</span>
		<span>{time(to)}</span>
	</div>
</div>

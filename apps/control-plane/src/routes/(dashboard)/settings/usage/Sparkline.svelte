<script lang="ts">
	/**
	 * A 30-day trend line for one usage meter. One series, so no legend: the row label names it.
	 * Hovering reads out a day's value; the daily table below is the accessible view.
	 */
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

	const WIDTH = 96;
	const HEIGHT = 28;
	const PAD = 3;

	let active = $state<number | null>(null);

	const top = $derived(Math.max(0, ...points.map((point) => point.value)));
	const x = (index: number) =>
		points.length <= 1 ? WIDTH - PAD : PAD + (index / (points.length - 1)) * (WIDTH - PAD * 2);
	const y = (value: number) =>
		top === 0 ? HEIGHT - PAD : HEIGHT - PAD - (value / top) * (HEIGHT - PAD * 2);

	const line = $derived(
		points.map((point, index) => `${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ')
	);
	const area = $derived(
		points.length > 1
			? `M${x(0).toFixed(1)},${HEIGHT - PAD} L${line.replaceAll(' ', ' L')} L${x(points.length - 1).toFixed(1)},${HEIGHT - PAD} Z`
			: ''
	);

	const shown = $derived(active ?? points.length - 1);
	const summary = $derived(
		points.length === 0
			? `${label}: no history yet`
			: `${label}: ${format(points[0]!.value)} on ${points[0]!.day}, ${format(points.at(-1)!.value)} on ${points.at(-1)!.day}`
	);

	function onpointermove(event: PointerEvent) {
		const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const ratio = (event.clientX - box.left) / box.width;
		active = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
	}

	function dayLabel(day: string): string {
		const date = new Date(`${day}T00:00:00Z`);
		return Number.isNaN(date.getTime())
			? day
			: date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
	}
</script>

{#if points.length > 1}
	<div
		class="relative {className}"
		role="presentation"
		{onpointermove}
		onpointerleave={() => (active = null)}
	>
		<svg
			viewBox="0 0 {WIDTH} {HEIGHT}"
			width={WIDTH}
			height={HEIGHT}
			class="block overflow-visible text-brand"
			role="img"
			aria-label={summary}
		>
			<path d={area} fill="currentColor" opacity="0.12" />
			<polyline
				points={line}
				fill="none"
				stroke="currentColor"
				stroke-width="1.5"
				stroke-linejoin="round"
				stroke-linecap="round"
				vector-effect="non-scaling-stroke"
			/>
			{#if active !== null}
				<line
					x1={x(active)}
					x2={x(active)}
					y1={PAD}
					y2={HEIGHT - PAD}
					class="stroke-muted-foreground/40"
					stroke-width="1"
				/>
			{/if}
			<circle
				cx={x(shown)}
				cy={y(points[shown]!.value)}
				r="2.5"
				fill="currentColor"
				class="stroke-card"
				stroke-width="1.5"
			/>
		</svg>
		{#if active !== null}
			<div
				class="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 rounded-md border bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground shadow-md"
				role="status"
			>
				<span class="text-muted-foreground">{dayLabel(points[active]!.day)}</span>
				<span class="ml-1.5 font-medium tabular-nums">{format(points[active]!.value)}</span>
			</div>
		{/if}
	</div>
{:else}
	<span class="block w-24 text-center text-xs text-muted-foreground {className}" title={summary}>
		—
	</span>
{/if}

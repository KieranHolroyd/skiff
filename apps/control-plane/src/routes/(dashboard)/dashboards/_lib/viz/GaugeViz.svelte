<script lang="ts">
	/**
	 * Radial gauges drawn as SVG: a 240° track, threshold bands along the outer edge, and the
	 * value arc coloured by the threshold it falls in.
	 */
	import type { ResolvedOptions } from '../panel.js';
	import type { Item } from '../series.js';
	import { cssColor, formatValue, sortThresholds, thresholdColor } from '../units.js';

	let {
		items,
		options,
		height,
		colors
	}: { items: Item[]; options: ResolvedOptions; height: number; colors: Map<string, string> } =
		$props();

	const shown = $derived(items.slice(0, 12));
	const START = -210;
	const SWEEP = 240;

	const domain = $derived.by(() => {
		const values = shown
			.map((item) => item.value)
			.filter((value): value is number => value !== null);
		const percent = options.unit === 'percent';
		const unit = options.unit === 'percentunit';
		const lo = options.min ?? 0;
		const hi =
			options.max ??
			(percent ? 100 : unit ? 1 : Math.max(lo + 1, ...values.map((value) => value * 1.2)));
		return { lo, hi: hi > lo ? hi : lo + 1 };
	});

	function point(angle: number, radius: number): [number, number] {
		const rad = (angle * Math.PI) / 180;
		return [50 + radius * Math.cos(rad), 50 + radius * Math.sin(rad)];
	}

	function arc(from: number, to: number, radius: number): string {
		const [x1, y1] = point(from, radius);
		const [x2, y2] = point(to, radius);
		const large = to - from > 180 ? 1 : 0;
		return `M ${x1.toFixed(3)} ${y1.toFixed(3)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(3)} ${y2.toFixed(3)}`;
	}

	const angleOf = (value: number) =>
		START + SWEEP * Math.max(0, Math.min(1, (value - domain.lo) / (domain.hi - domain.lo)));

	const bands = $derived.by(() => {
		const steps = sortThresholds(options.thresholds);
		return steps
			.map((step, index) => {
				const from = step.value === null ? domain.lo : step.value;
				const next = steps[index + 1]?.value ?? domain.hi;
				return { from: angleOf(from), to: angleOf(next), color: cssColor(step.color) };
			})
			.filter((band) => band.to > band.from);
	});

	const columns = $derived(Math.min(shown.length, 4));
</script>

<div
	class="grid size-full items-center gap-2"
	style:grid-template-columns="repeat({Math.max(1, columns)}, minmax(0, 1fr))"
	style:height="{height}px"
>
	{#each shown as item (item.name)}
		{@const color =
			thresholdColor(item.value, options.thresholds) ??
			colors.get(item.name) ??
			'var(--color-chart-1)'}
		<figure class="flex h-full min-h-0 min-w-0 flex-col items-center justify-center">
			<svg
				viewBox="0 8 100 80"
				class="h-full max-h-full w-full"
				role="img"
				aria-label="{item.name}: {formatValue(item.value, options.unit, options.decimals)}"
			>
				<path
					d={arc(START, START + SWEEP, 38)}
					fill="none"
					stroke="var(--color-muted)"
					stroke-width="9"
					stroke-linecap="round"
				/>
				{#each bands as band, index (index)}
					<path
						d={arc(band.from, band.to, 45)}
						fill="none"
						stroke={band.color}
						stroke-width="2"
						opacity="0.8"
					/>
				{/each}
				{#if item.value !== null && item.value > domain.lo}
					<path
						d={arc(START, angleOf(item.value), 38)}
						fill="none"
						stroke={color}
						stroke-width="9"
						stroke-linecap="round"
					/>
				{/if}
				<text
					x="50"
					y="54"
					text-anchor="middle"
					dominant-baseline="middle"
					class="fill-foreground font-semibold tabular-nums"
					style:font-size="13px"
				>
					{formatValue(item.value, options.unit, options.decimals)}
				</text>
				<text x="22" y="84" text-anchor="middle" class="fill-muted-foreground" style:font-size="5px"
					>{formatValue(domain.lo, options.unit, options.decimals)}</text
				>
				<text x="78" y="84" text-anchor="middle" class="fill-muted-foreground" style:font-size="5px"
					>{formatValue(domain.hi, options.unit, options.decimals)}</text
				>
			</svg>
			{#if shown.length > 1}
				<figcaption class="max-w-full truncate text-xs text-muted-foreground">
					{item.name}
				</figcaption>
			{/if}
		</figure>
	{/each}
</div>

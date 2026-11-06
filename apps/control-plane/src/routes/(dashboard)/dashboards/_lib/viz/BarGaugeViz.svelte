<script lang="ts">
	/** Horizontal bars, one per item, sorted as the query returned them. */
	import type { ResolvedOptions } from '../panel.js';
	import type { Item } from '../series.js';
	import { formatValue, thresholdColor } from '../units.js';

	let {
		items,
		options,
		height,
		colors
	}: { items: Item[]; options: ResolvedOptions; height: number; colors: Map<string, string> } =
		$props();

	const top = $derived(
		options.max ??
			Math.max(0, ...items.map((item) => item.value ?? 0).filter((value) => Number.isFinite(value)))
	);
	const lo = $derived(options.min ?? 0);
</script>

<ul class="flex flex-col justify-center gap-1.5 overflow-y-auto pr-1" style:height="{height}px">
	{#each items as item (item.name)}
		{@const color =
			thresholdColor(item.value, options.thresholds) ??
			colors.get(item.name) ??
			'var(--color-chart-1)'}
		{@const fraction =
			item.value === null || top <= lo
				? 0
				: Math.max(0, Math.min(1, (item.value - lo) / (top - lo)))}
		<li class="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2 text-xs">
			<span class="truncate text-muted-foreground" title={item.name}>{item.name}</span>
			<span class="relative h-4 overflow-hidden rounded-sm bg-muted">
				<span
					class="absolute inset-y-0 left-0 rounded-sm"
					style:width="{fraction * 100}%"
					style:background={color}
					style:opacity="0.85"
				></span>
			</span>
			<span class="min-w-14 text-right font-mono tabular-nums" style:color
				>{formatValue(item.value, options.unit, options.decimals)}</span
			>
		</li>
	{/each}
</ul>

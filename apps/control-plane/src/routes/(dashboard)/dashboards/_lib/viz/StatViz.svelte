<script lang="ts">
	/** Big numbers, one tile per item, coloured by thresholds, with a sparkline for time data. */
	import type { ResolvedOptions } from '../panel.js';
	import type { Item } from '../series.js';
	import { formatValue, thresholdColor } from '../units.js';
	import Sparkline from './Sparkline.svelte';

	let {
		items,
		options,
		height,
		colors
	}: { items: Item[]; options: ResolvedOptions; height: number; colors: Map<string, string> } =
		$props();

	const shown = $derived(items.slice(0, 24));
	const columns = $derived(
		Math.min(shown.length, shown.length > 6 ? 4 : shown.length > 3 ? 3 : shown.length)
	);
	const rows = $derived(Math.max(1, Math.ceil(shown.length / Math.max(1, columns))));
	const tileHeight = $derived(height / rows);
</script>

<div
	class="grid size-full gap-2"
	style:grid-template-columns="repeat({Math.max(1, columns)}, minmax(0, 1fr))"
	style:height="{height}px"
>
	{#each shown as item (item.name)}
		{@const color = thresholdColor(item.value, options.thresholds) ?? 'var(--color-foreground)'}
		{@const spark =
			thresholdColor(item.value, options.thresholds) ??
			colors.get(item.name) ??
			'var(--color-chart-1)'}
		<div
			class="stat-tile relative flex min-w-0 flex-col items-center justify-center overflow-hidden rounded-md"
		>
			{#if shown.length > 1}
				<span class="max-w-full truncate px-1 text-xs text-muted-foreground">{item.name}</span>
			{/if}
			<span
				class="z-10 max-w-full truncate px-1 font-semibold tracking-tight tabular-nums"
				style:color
				style:font-size="clamp(0.9rem, min(32cqh, 16cqi), 3.25rem)"
				title={item.value === null ? 'No value' : String(item.value)}
			>
				{formatValue(item.value, options.unit, options.decimals)}
			</span>
			{#if item.values && tileHeight > 70}
				<div class="absolute inset-x-0 bottom-0 opacity-80">
					<Sparkline
						values={item.values}
						color={spark}
						height={Math.min(48, Math.round(tileHeight * 0.35))}
					/>
				</div>
			{/if}
		</div>
	{/each}
</div>

<style>
	.stat-tile {
		container-type: size;
	}
</style>

<script lang="ts">
	/** A donut drawn as SVG arcs, with a hover readout in the hole. */
	import type { ResolvedOptions } from '../panel.js';
	import type { Item } from '../series.js';
	import { formatValue } from '../units.js';

	let {
		items,
		options,
		height,
		colors,
		hidden
	}: {
		items: Item[];
		options: ResolvedOptions;
		height: number;
		colors: Map<string, string>;
		hidden: Set<string>;
	} = $props();

	const slices = $derived.by(() => {
		const positive = items.filter((item) => !hidden.has(item.name) && (item.value ?? 0) > 0);
		const total = positive.reduce((sum, item) => sum + (item.value ?? 0), 0);
		let angle = -Math.PI / 2;
		return {
			total,
			list: positive.map((item) => {
				const share = total > 0 ? (item.value ?? 0) / total : 0;
				const start = angle;
				angle += share * Math.PI * 2;
				return { ...item, share, start, end: angle };
			})
		};
	});

	let active = $state<string | null>(null);
	const focused = $derived(slices.list.find((slice) => slice.name === active) ?? null);

	function path(start: number, end: number): string {
		const outer = 46;
		const inner = 28;
		// A full circle needs two arcs.
		if (end - start >= Math.PI * 2 - 1e-6) end = start + Math.PI * 2 - 1e-4;
		const large = end - start > Math.PI ? 1 : 0;
		const p = (radius: number, angle: number) =>
			`${(50 + radius * Math.cos(angle)).toFixed(3)} ${(50 + radius * Math.sin(angle)).toFixed(3)}`;
		return `M ${p(outer, start)} A ${outer} ${outer} 0 ${large} 1 ${p(outer, end)} L ${p(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${p(inner, start)} Z`;
	}
</script>

<div class="flex items-center justify-center" style:height="{height}px">
	{#if slices.total > 0}
		<svg viewBox="0 0 100 100" class="h-full max-w-full" role="img" aria-label="Share by series">
			{#each slices.list as slice (slice.name)}
				<path
					d={path(slice.start, slice.end)}
					fill={colors.get(slice.name) ?? 'var(--color-chart-1)'}
					stroke="var(--color-card)"
					stroke-width="0.6"
					opacity={active && active !== slice.name ? 0.45 : 1}
					role="presentation"
					onpointerenter={() => (active = slice.name)}
					onpointerleave={() => (active = null)}
				>
					<title
						>{slice.name}: {formatValue(slice.value, options.unit, options.decimals)} ({(
							slice.share * 100
						).toFixed(1)}%)</title
					>
				</path>
			{/each}
			<text
				x="50"
				y={focused ? 47 : 50}
				text-anchor="middle"
				dominant-baseline="middle"
				class="fill-foreground font-semibold tabular-nums"
				style:font-size="8px"
			>
				{formatValue(focused ? focused.value : slices.total, options.unit, options.decimals)}
			</text>
			<text
				x="50"
				y={focused ? 56 : 58}
				text-anchor="middle"
				class="fill-muted-foreground"
				style:font-size="4.5px"
			>
				{focused ? `${(focused.share * 100).toFixed(1)}% · ${focused.name.slice(0, 24)}` : 'total'}
			</text>
		</svg>
	{:else}
		<span class="text-sm text-muted-foreground">No positive values</span>
	{/if}
</div>

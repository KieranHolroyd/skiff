<script lang="ts">
	/**
	 * A small bar chart for event counts. Hovering (or focusing) a bar swaps the header readout from
	 * the total to that bucket, so exact numbers are one pointer move away without a tooltip layer.
	 * Empty buckets draw as faint stubs, so a quiet day still reads as a day.
	 */
	let {
		values,
		labels,
		title,
		unit = 'events',
		tone = 'primary',
		height = 'h-16',
		showHeader = true,
		class: className = ''
	}: {
		values: number[];
		labels: string[];
		title?: string;
		unit?: string;
		tone?: 'primary' | 'muted' | 'danger';
		height?: string;
		showHeader?: boolean;
		class?: string;
	} = $props();

	let hovered = $state<number | null>(null);
	const max = $derived(Math.max(1, ...values));
	const total = $derived(values.reduce((sum, value) => sum + value, 0));
	const fill = $derived(
		{ primary: 'bg-primary/70', muted: 'bg-primary/35', danger: 'bg-destructive/70' }[tone]
	);
	const active = $derived(
		{ primary: 'bg-primary', muted: 'bg-primary/60', danger: 'bg-destructive' }[tone]
	);
	const readout = $derived(
		hovered === null
			? { label: title ?? '', value: total }
			: { label: labels[hovered] ?? '', value: values[hovered] ?? 0 }
	);
	const unitFor = (value: number) => (value === 1 ? unit.replace(/s$/, '') : unit);
</script>

<div class="space-y-1.5 {className}">
	{#if showHeader}
		<div class="flex items-baseline justify-between gap-2 text-xs">
			<span class="truncate text-muted-foreground">{readout.label}</span>
			<span class="shrink-0 tabular-nums">
				<span class="font-medium">{readout.value.toLocaleString('en-GB')}</span>
				<span class="text-muted-foreground">{unitFor(readout.value)}</span>
			</span>
		</div>
	{/if}
	<div
		class="flex items-end gap-[2px] {height}"
		role="img"
		aria-label="{title ?? 'Chart'}: {values
			.map((value, index) => `${labels[index]} ${value}`)
			.join(', ')}"
		onpointerleave={() => (hovered = null)}
	>
		{#each values as value, index (index)}
			<div
				class="flex h-full min-w-0 flex-1 items-end"
				onpointerenter={() => (hovered = index)}
				aria-hidden="true"
			>
				<div
					class="w-full rounded-[2px] transition-colors {value > 0
						? hovered === index
							? active
							: fill
						: hovered === index
							? 'bg-muted-foreground/40'
							: 'bg-muted'}"
					style="height: {value > 0 ? Math.max(8, (value / max) * 100) : 6}%"
				></div>
			</div>
		{/each}
	</div>
</div>

<script lang="ts">
	/**
	 * A tiny bar chart of counts, oldest first. Bars are relative to the busiest bucket; empty
	 * buckets keep a hairline so the time axis still reads.
	 */
	let {
		values,
		labels = [],
		height = 'h-10',
		class: className = ''
	}: {
		values: number[];
		/** One per bar, for the tooltip ("14:00"). */
		labels?: string[];
		height?: string;
		class?: string;
	} = $props();

	const max = $derived(Math.max(1, ...values));
</script>

<div
	class="flex items-end gap-px {height} {className}"
	role="img"
	aria-label={`${values.reduce((a, b) => a + b, 0)} events`}
>
	{#each values as value, index (index)}
		<div
			class="min-w-0 flex-1 rounded-[1px] {value > 0 ? 'bg-destructive/70' : 'bg-border'}"
			style:height={value > 0 ? `${Math.max(8, (value / max) * 100)}%` : '1px'}
			title={`${labels[index] ? `${labels[index]}: ` : ''}${value.toLocaleString('en-GB')}`}
		></div>
	{/each}
</div>

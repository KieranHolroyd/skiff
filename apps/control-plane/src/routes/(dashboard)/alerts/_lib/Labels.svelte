<script lang="ts">
	/** A series' labels as small chips; id labels show their display names. */
	import { labelPairs } from './rules.js';

	let {
		labels,
		labelNames = {},
		class: className = ''
	}: {
		labels: Record<string, string>;
		labelNames?: Record<string, string>;
		class?: string;
	} = $props();

	const pairs = $derived(labelPairs(labels, labelNames));
</script>

{#if pairs.length === 0}
	<span class="text-xs text-muted-foreground {className}">All series</span>
{:else}
	<span class="flex min-w-0 flex-wrap gap-1 {className}">
		{#each pairs as pair (pair.label)}
			<span
				class="inline-flex max-w-full items-center gap-1 truncate rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]"
				title="{pair.label}={pair.value}"
			>
				{#if pair.named}<span class="text-muted-foreground">{pair.label}=</span>{/if}<span
					class="truncate">{pair.text}</span
				>
			</span>
		{/each}
	</span>
{/if}

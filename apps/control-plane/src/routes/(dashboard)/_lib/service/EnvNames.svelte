<script lang="ts">
	import { Badge } from '#lib/components/ui/badge/index.js';

	/**
	 * The env vars an attachment injects. Long lists collapse to the first few with a "+N" toggle,
	 * so a row stays one line tall until someone asks for the rest.
	 */
	let { names, limit = 3 }: { names: string[]; limit?: number } = $props();

	let expanded = $state(false);
	const shown = $derived(expanded ? names : names.slice(0, limit));
	const hidden = $derived(names.length - shown.length);
</script>

<div class="flex flex-wrap items-center gap-1" title={names.join('\n')}>
	{#each shown as name (name)}
		<Badge variant="secondary" class="font-mono font-normal">{name}</Badge>
	{/each}
	{#if hidden > 0}
		<button
			type="button"
			class="rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
			onclick={() => (expanded = true)}
			aria-label="Show all {names.length} env vars"
		>
			+{hidden} more
		</button>
	{:else if expanded && names.length > limit}
		<button
			type="button"
			class="rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
			onclick={() => (expanded = false)}
		>
			Show less
		</button>
	{/if}
</div>

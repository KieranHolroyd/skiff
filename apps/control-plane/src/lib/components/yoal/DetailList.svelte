<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.js';

	/** A "key: value" list. Children are plain `<dt>` / `<dd>` pairs; values sit right-aligned. */
	let { class: className = '', children }: { class?: string; children: Snippet } = $props();
</script>

<dl
	class={cn(
		'grid grid-cols-[minmax(6.5rem,auto)_1fr] text-sm',
		'*:border-b *:py-2 [&>dd]:min-w-0 [&>dd]:text-right [&>dt]:pr-4 [&>dt]:text-muted-foreground',
		'[&>dd:last-of-type]:border-b-0 [&>dt:last-of-type]:border-b-0',
		className
	)}
>
	{@render children()}
</dl>

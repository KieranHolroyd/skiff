<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		eyebrow,
		description,
		meta,
		children
	}: {
		title: string;
		eyebrow?: string;
		description?: string;
		/** Extra detail rendered under the title (URLs, badges). */
		meta?: Snippet;
		/** Actions, right-aligned. */
		children?: Snippet;
	} = $props();
</script>

<header class="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b pb-6">
	<div class="min-w-0 space-y-1.5">
		{#if eyebrow}<p class="eyebrow">{eyebrow}</p>{/if}
		<h1 class="text-[26px] leading-tight font-semibold tracking-[-0.03em] text-balance">{title}</h1>
		{#if description}
			<p class="max-w-2xl text-sm leading-relaxed text-pretty text-muted-foreground">{description}</p>
		{/if}
		{#if meta}<div class="pt-1">{@render meta()}</div>{/if}
	</div>
	{#if children}
		<div class="flex shrink-0 flex-wrap items-center gap-2">
			{@render children()}
		</div>
	{/if}
</header>

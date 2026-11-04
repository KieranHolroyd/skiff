<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		eyebrow,
		description,
		meta,
		bordered = true,
		children
	}: {
		title: string;
		eyebrow?: string;
		description?: string;
		/** Extra detail rendered under the title (URLs, badges). */
		meta?: Snippet;
		/** Draw the bottom rule; turn off when tabs sit directly underneath. */
		bordered?: boolean;
		/** Actions, right-aligned. */
		children?: Snippet;
	} = $props();
</script>

<header
	class="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 {bordered
		? 'border-b pb-6'
		: 'pb-4'}"
>
	<div class="min-w-0 space-y-1">
		{#if eyebrow}<p class="text-sm text-muted-foreground">{eyebrow}</p>{/if}
		<h1 class="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
		{#if description}
			<p class="max-w-2xl text-sm text-pretty text-muted-foreground">
				{description}
			</p>
		{/if}
		{#if meta}<div class="pt-1">{@render meta()}</div>{/if}
	</div>
	{#if children}
		<div class="flex shrink-0 flex-wrap items-center gap-2">
			{@render children()}
		</div>
	{/if}
</header>

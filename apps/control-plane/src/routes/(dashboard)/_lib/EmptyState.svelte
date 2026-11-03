<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		description,
		children
	}: {
		title: string;
		description?: string;
		children?: Snippet;
	} = $props();
</script>

<div
	class="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center"
>
	<div class="space-y-1">
		<p class="text-sm font-medium">{title}</p>
		{#if description}
			<p class="mx-auto max-w-md text-sm text-muted-foreground">{description}</p>
		{/if}
	</div>
	{#if children}
		<div class="flex flex-wrap items-center justify-center gap-2">
			{@render children()}
		</div>
	{/if}
</div>

<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import type { Snippet } from 'svelte';

	/** One numbered section of the template form, on a vertical track that fills in as it is done. */
	let {
		number,
		id,
		title,
		description,
		done,
		last = false,
		children
	}: {
		number: number;
		id: string;
		title: string;
		description?: string;
		done: boolean;
		last?: boolean;
		children: Snippet;
	} = $props();
</script>

<li id="section-{id}" class="relative scroll-mt-24 pb-8 pl-11" class:pb-0={last}>
	{#if !last}
		<span
			class="absolute top-9 bottom-1 left-[13px] w-px transition-colors duration-500 {done
				? 'bg-success/40'
				: 'bg-border'}"
			aria-hidden="true"
		></span>
	{/if}
	<span
		class="absolute top-0.5 left-0 flex size-7 items-center justify-center rounded-full text-xs font-semibold tabular-nums transition-all duration-300 {done
			? 'bg-success text-background'
			: 'border bg-background text-muted-foreground'}"
		aria-hidden="true"
	>
		{#if done}<CheckIcon
				class="size-3.5 animate-in zoom-in-50"
				strokeWidth={3}
			/>{:else}{number}{/if}
	</span>
	<div class="mb-3 space-y-0.5">
		<h2 class="text-base leading-7 font-semibold">
			{title}<span class="sr-only">{done ? ' (complete)' : ''}</span>
		</h2>
		{#if description}
			<p class="text-sm text-pretty text-muted-foreground">{description}</p>
		{/if}
	</div>
	<div class="rounded-xl border bg-card p-5 shadow-xs">
		{@render children()}
	</div>
</li>

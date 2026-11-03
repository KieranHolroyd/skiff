<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import * as Card from '#lib/components/ui/card/index.js';

	/**
	 * The standard dashboard section: a card with a titled header, optional actions and a body.
	 * `flush` removes body padding for edge-to-edge tables and lists.
	 */
	let {
		title,
		description,
		icon: Icon,
		count,
		actions,
		children,
		footer,
		flush = false,
		id,
		class: className = ''
	}: {
		title: string;
		description?: string;
		icon?: Component<{ class?: string }>;
		count?: number;
		actions?: Snippet;
		children: Snippet;
		footer?: Snippet;
		flush?: boolean;
		id?: string;
		class?: string;
	} = $props();
</script>

<Card.Root {id} class="gap-0 py-0 {className}">
	<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b px-4 py-3.5">
		<div class="flex min-w-0 items-start gap-3">
			{#if Icon}
				<span class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border bg-muted/40 text-muted-foreground">
					<span aria-hidden="true"><Icon class="size-3.5" /></span>
				</span>
			{/if}
			<div class="min-w-0 space-y-0.5">
				<h2 class="flex items-center gap-2 text-[14.5px] font-semibold tracking-[-0.01em]">
					{title}
					{#if count !== undefined}
						<span class="rounded-md bg-muted px-1.5 py-px font-mono text-[11px] font-medium text-muted-foreground tabular-nums">{count}</span>
					{/if}
				</h2>
				{#if description}
					<p class="text-[13px] leading-relaxed text-pretty text-muted-foreground">{description}</p>
				{/if}
			</div>
		</div>
		{#if actions}
			<div class="flex shrink-0 flex-wrap items-center gap-2">{@render actions()}</div>
		{/if}
	</div>
	<div class={flush ? '' : 'p-4'}>
		{@render children()}
	</div>
	{#if footer}
		<div class="border-t bg-muted/30 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
			{@render footer()}
		</div>
	{/if}
</Card.Root>

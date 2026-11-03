<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import * as Card from '#lib/components/ui/card/index.js';

	/** A titled Card section. `flush` drops body padding for edge-to-edge tables and lists. */
	let {
		title,
		icon: Icon,
		description,
		count,
		actions,
		children,
		footer,
		flush = false,
		id,
		class: className = ''
	}: {
		title: string;
		icon?: Component<{ class?: string }>;
		description?: string;
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
	<Card.Header class="border-b py-4">
		<Card.Title class="flex items-center gap-2">
			{#if Icon}
				<span class="grid size-6 shrink-0 place-items-center rounded-md border bg-muted/40 text-muted-foreground">
					<Icon class="size-3.5" />
				</span>
			{/if}
			{title}
			{#if count !== undefined}
				<span
					class="rounded-md bg-muted px-1.5 py-px font-mono text-[11px] font-medium text-muted-foreground tabular-nums"
					>{count}</span
				>
			{/if}
		</Card.Title>
		{#if description}<Card.Description>{description}</Card.Description>{/if}
		{#if actions}<Card.Action class="flex items-center gap-2 self-center">{@render actions()}</Card.Action>{/if}
	</Card.Header>
	<Card.Content class={flush ? 'px-0' : 'py-4'}>
		{@render children()}
	</Card.Content>
	{#if footer}
		<Card.Footer class="py-3 text-xs leading-relaxed text-muted-foreground">
			{@render footer()}
		</Card.Footer>
	{/if}
</Card.Root>

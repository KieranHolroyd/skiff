<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
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
			{#if Icon}<Icon class="size-4 text-muted-foreground" />{/if}
			{title}
			{#if count !== undefined}
				<Badge variant="secondary" class="tabular-nums">{count}</Badge>
			{/if}
		</Card.Title>
		{#if description}<Card.Description>{description}</Card.Description>{/if}
		{#if actions}<Card.Action class="flex items-center gap-2 self-center"
				>{@render actions()}</Card.Action
			>{/if}
	</Card.Header>
	<Card.Content class={flush ? 'px-0' : 'py-4'}>
		{@render children()}
	</Card.Content>
	{#if footer}
		<Card.Footer class="py-3 text-xs text-muted-foreground">
			{@render footer()}
		</Card.Footer>
	{/if}
</Card.Root>

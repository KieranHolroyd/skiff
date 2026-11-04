<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import * as Empty from '#lib/components/ui/empty/index.js';

	let {
		title,
		description,
		icon: Icon = InboxIcon,
		compact = false,
		children
	}: {
		title: string;
		description?: string;
		icon?: Component<{ class?: string }>;
		compact?: boolean;
		children?: Snippet;
	} = $props();
</script>

<Empty.Root class="border border-dashed {compact ? 'py-8' : 'py-12'}">
	<Empty.Header>
		<Empty.Media variant="icon">
			<Icon />
		</Empty.Media>
		<Empty.Title>{title}</Empty.Title>
		{#if description}<Empty.Description>{description}</Empty.Description>{/if}
	</Empty.Header>
	{#if children}
		<Empty.Content class="flex-row flex-wrap justify-center">{@render children()}</Empty.Content>
	{/if}
</Empty.Root>

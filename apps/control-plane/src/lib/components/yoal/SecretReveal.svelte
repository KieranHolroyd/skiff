<script lang="ts">
	import type { Snippet } from 'svelte';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import * as Card from '#lib/components/ui/card/index.js';
	import CopyButton from './CopyButton.svelte';

	/** A one-time secret (API key, token, share link, join command) that cannot be shown again. */
	let {
		title,
		description,
		value,
		copyLabel = 'Copy',
		multiline = false,
		children
	}: {
		title: string;
		description?: string;
		value: string;
		copyLabel?: string;
		multiline?: boolean;
		children?: Snippet;
	} = $props();
</script>

<Card.Root class="border-brand/40" aria-label={title}>
	<Card.Header>
		<Card.Title class="flex items-center gap-2">
			<KeyRoundIcon class="size-4 text-brand" aria-hidden="true" />
			{title}
		</Card.Title>
		{#if description}<Card.Description>{description}</Card.Description>{/if}
		<Card.Action>
			<CopyButton {value} label={copyLabel} variant="default" size="sm" />
		</Card.Action>
	</Card.Header>
	<Card.Content class="space-y-3">
		{#if multiline}
			<pre
				class="overflow-auto rounded-md border bg-muted p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap select-all">{value}</pre>
		{:else}
			<code
				class="block overflow-auto rounded-md border bg-muted p-3 font-mono text-xs break-all select-all"
				>{value}</code
			>
		{/if}
		{@render children?.()}
	</Card.Content>
</Card.Root>

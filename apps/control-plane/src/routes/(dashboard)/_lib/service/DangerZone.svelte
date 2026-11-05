<script lang="ts">
	import type { Snippet } from 'svelte';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import * as Card from '#lib/components/ui/card/index.js';

	/** The red-bordered card at the bottom of a settings section. */
	let {
		description,
		children
	}: {
		description: Snippet;
		/** The destructive buttons. */
		children: Snippet;
	} = $props();
</script>

<Card.Root class="gap-0 border-destructive/30 py-0">
	<Card.Header class="py-4">
		<Card.Title class="flex items-center gap-2 text-destructive">
			<TriangleAlertIcon class="size-4" />
			Danger zone
		</Card.Title>
		<Card.Description>{@render description()}</Card.Description>
		<Card.Action class="flex flex-wrap gap-2 self-center">{@render children()}</Card.Action>
	</Card.Header>
</Card.Root>

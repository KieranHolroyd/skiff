<script lang="ts">
	import type { Snippet } from 'svelte';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import CopyButton from './CopyButton.svelte';

	/** Shows a one-time secret (API key, token, share link, join command). Outside clicks are ignored. */
	let {
		open = $bindable(false),
		title,
		description,
		value,
		multiline = false,
		children
	}: {
		open?: boolean;
		title: string;
		description?: string;
		value: string;
		multiline?: boolean;
		children?: Snippet;
	} = $props();
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl" interactOutsideBehavior="ignore">
		<Dialog.Header class="flex-row items-start gap-3.5">
			<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-brand text-brand-foreground">
				<KeyRoundIcon class="size-4" />
			</span>
			<div class="space-y-1.5">
				<Dialog.Title>{title}</Dialog.Title>
				{#if description}<Dialog.Description>{description}</Dialog.Description>{/if}
			</div>
		</Dialog.Header>

		<InputGroup.Root class="h-auto">
			{#if multiline}
				<InputGroup.Textarea
					readonly
					{value}
					rows={3}
					class="resize-none font-mono text-xs leading-relaxed"
					aria-label={title}
				/>
				<InputGroup.Addon align="block-end" class="justify-end border-t">
					<CopyButton {value} label="Copy" variant="default" size="sm" />
				</InputGroup.Addon>
			{:else}
				<InputGroup.Input readonly {value} class="font-mono text-xs" aria-label={title} />
				<InputGroup.Addon align="inline-end">
					<CopyButton {value} label="Copy" variant="default" size="xs" />
				</InputGroup.Addon>
			{/if}
		</InputGroup.Root>

		{@render children?.()}

		<Alert.Root variant="warning">
			<TriangleAlertIcon />
			<Alert.Description>This is the only time it is shown. Store it somewhere safe.</Alert.Description>
		</Alert.Root>

		<Dialog.Footer>
			<Dialog.Close>
				{#snippet child({ props })}<Button {...props}>Done</Button>{/snippet}
			</Dialog.Close>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

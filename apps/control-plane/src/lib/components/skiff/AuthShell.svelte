<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Card from '#lib/components/ui/card/index.js';
	import Logo from './Logo.svelte';
	import ThemeToggle from './ThemeToggle.svelte';

	let {
		eyebrow,
		title,
		description,
		children,
		footer
	}: {
		eyebrow?: string;
		title: string;
		description?: Snippet | string;
		children: Snippet;
		footer?: Snippet;
	} = $props();
</script>

<div
	class="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10 dark:bg-background"
>
	<div class="flex w-full max-w-sm flex-col gap-6">
		<Logo class="self-center" />
		<Card.Root>
			<Card.Header class="text-center">
				{#if eyebrow}<p class="text-xs font-medium text-brand">{eyebrow}</p>{/if}
				<Card.Title class="text-xl text-balance">{title}</Card.Title>
				{#if typeof description === 'string'}
					<Card.Description class="text-pretty">{description}</Card.Description>
				{:else if description}
					<Card.Description class="text-pretty">{@render description()}</Card.Description>
				{/if}
			</Card.Header>
			<Card.Content>
				{@render children()}
			</Card.Content>
		</Card.Root>
		{#if footer}
			<div class="px-6 text-center text-xs text-balance text-muted-foreground">
				{@render footer()}
			</div>
		{/if}
		<div class="flex justify-center">
			<ThemeToggle />
		</div>
	</div>
</div>

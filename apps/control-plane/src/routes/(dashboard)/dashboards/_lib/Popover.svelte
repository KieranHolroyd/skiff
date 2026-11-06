<script lang="ts">
	/**
	 * A popover panel (bits-ui Popover, styled like the dashboard's dropdown menus) for pickers
	 * that hold form fields, which a menu's typeahead would get in the way of.
	 */
	import { Popover } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.js';

	let {
		open = $bindable(false),
		trigger,
		children,
		align = 'end',
		class: className = ''
	}: {
		open?: boolean;
		trigger: Snippet<[{ props: Record<string, unknown> }]>;
		children: Snippet;
		align?: 'start' | 'center' | 'end';
		class?: string;
	} = $props();
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			{@render trigger({ props })}
		{/snippet}
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content
			sideOffset={4}
			{align}
			class={cn(
				'z-50 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
				className
			)}
		>
			{@render children()}
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>

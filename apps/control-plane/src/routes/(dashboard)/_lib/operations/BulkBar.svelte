<script lang="ts">
	import type { OperationActionInfo } from '@yoal/contracts';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';

	/**
	 * The sticky bar shown while rows are selected. `primary` actions get buttons; anything else
	 * the registry offers for this list goes under "More actions", so new actions need no UI work.
	 */
	let {
		count,
		primary,
		more,
		planning,
		disabled = false,
		onrun,
		onclear
	}: {
		count: number;
		primary: OperationActionInfo[];
		more: OperationActionInfo[];
		planning: string | null;
		disabled?: boolean;
		onrun: (info: OperationActionInfo) => void;
		onclear: () => void;
	} = $props();
</script>

<div
	class="mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border bg-popover px-3 py-2 text-sm shadow-lg"
	role="region"
	aria-label="Bulk actions"
>
	<span class="pr-1 font-medium tabular-nums">{count} selected</span>
	<span class="text-muted-foreground" aria-hidden="true">·</span>
	{#each primary as info (info.id)}
		<Button
			size="sm"
			variant={info.destructive ? (info.reversible ? 'outline' : 'destructive') : 'default'}
			class={info.destructive && info.reversible
				? 'text-destructive hover:bg-destructive/10 hover:text-destructive'
				: ''}
			disabled={disabled || planning !== null}
			onclick={() => onrun(info)}
		>
			{#if planning === info.id}<Spinner />{/if}
			{info.verb}
		</Button>
	{/each}
	{#if more.length}
		<DropdownMenu.Root>
			<DropdownMenu.Trigger disabled={disabled || planning !== null}>
				{#snippet child({ props })}
					<Button {...props} size="sm" variant="outline">
						{#if planning && more.some((info) => info.id === planning)}<Spinner />{/if}
						More actions
						<ChevronDownIcon />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-56">
				{#each more as info (info.id)}
					<DropdownMenu.Item
						variant={info.destructive ? 'destructive' : 'default'}
						onSelect={() => onrun(info)}
					>
						{info.label}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	{/if}
	<span class="text-muted-foreground" aria-hidden="true">·</span>
	<Button size="sm" variant="ghost" onclick={onclear} disabled={planning !== null}>
		<XIcon />
		Clear
	</Button>
</div>

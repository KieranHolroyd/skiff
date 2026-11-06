<script lang="ts">
	/** Manual refresh plus the auto-refresh interval (off, 10s … 1h). */
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as ButtonGroup from '#lib/components/ui/button-group/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { REFRESH_OPTIONS } from './time.js';

	let {
		value,
		busy = false,
		onchange,
		onrefresh
	}: {
		value: string | null;
		busy?: boolean;
		onchange: (value: string | null) => void;
		onrefresh: () => void;
	} = $props();
</script>

<ButtonGroup.Root aria-label="Refresh">
	<Button
		variant="outline"
		size={value ? 'default' : 'icon'}
		aria-label="Refresh now"
		title="Refresh now"
		onclick={onrefresh}
	>
		<RefreshCwIcon class={busy ? 'animate-spin' : ''} />
		{#if value}<span class="font-mono text-xs">{value}</span>{/if}
	</Button>
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					variant="outline"
					size="icon"
					aria-label="Auto refresh: {value ?? 'off'}"
				>
					<ChevronDownIcon />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" class="w-36 min-w-0">
			<DropdownMenu.Label class="text-xs text-muted-foreground">Auto refresh</DropdownMenu.Label>
			<DropdownMenu.RadioGroup
				value={value ?? 'off'}
				onValueChange={(next) => onchange(next === 'off' ? null : next)}
			>
				<DropdownMenu.RadioItem value="off">Off</DropdownMenu.RadioItem>
				{#each REFRESH_OPTIONS as option (option)}
					<DropdownMenu.RadioItem value={option}>{option}</DropdownMenu.RadioItem>
				{/each}
			</DropdownMenu.RadioGroup>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
</ButtonGroup.Root>

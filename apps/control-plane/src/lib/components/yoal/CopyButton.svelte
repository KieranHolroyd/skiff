<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import { toast } from 'svelte-sonner';
	import { Button, type ButtonSize, type ButtonVariant } from '#lib/components/ui/button/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';

	let {
		value,
		label = 'Copy',
		variant = 'outline',
		size = 'sm',
		iconOnly = false,
		class: className = ''
	}: {
		value: string;
		label?: string;
		variant?: ButtonVariant;
		size?: ButtonSize;
		iconOnly?: boolean;
		class?: string;
	} = $props();

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		try {
			await navigator.clipboard.writeText(value);
			copied = true;
			clearTimeout(timer);
			timer = setTimeout(() => (copied = false), 1600);
		} catch {
			toast.error('Could not copy to the clipboard.');
		}
	}
</script>

{#if iconOnly}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					type="button"
					variant={variant === 'outline' ? 'ghost' : variant}
					size="icon-xs"
					class={className}
					onclick={copy}
					aria-label={label}
				>
					{#if copied}<CheckIcon class="text-success" />{:else}<CopyIcon />{/if}
				</Button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>{copied ? 'Copied' : label}</Tooltip.Content>
	</Tooltip.Root>
{:else}
	<Button type="button" {size} {variant} class={className} onclick={copy}>
		{#if copied}<CheckIcon />Copied{:else}<CopyIcon />{label}{/if}
	</Button>
{/if}

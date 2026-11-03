<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import { Button, type ButtonSize, type ButtonVariant } from '#lib/components/ui/button/index.js';

	let {
		value,
		label = 'Copy',
		variant = 'outline',
		size = 'xs',
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
	let resetTimer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		try {
			await navigator.clipboard.writeText(value);
			copied = true;
			if (resetTimer) clearTimeout(resetTimer);
			resetTimer = setTimeout(() => (copied = false), 1600);
		} catch {
			copied = false;
		}
	}
</script>

<Button
	type="button"
	{size}
	{variant}
	class={className}
	onclick={copy}
	aria-label={iconOnly ? label : undefined}
	title={iconOnly ? label : undefined}
>
	{#if copied}
		<CheckIcon class="size-3.5 text-success" aria-hidden="true" />
		{#if !iconOnly}Copied{/if}
	{:else}
		<CopyIcon class="size-3.5" aria-hidden="true" />
		{#if !iconOnly}{label}{/if}
	{/if}
	<span class="sr-only" aria-live="polite">{copied ? 'Copied to clipboard' : ''}</span>
</Button>

<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import { Button, type ButtonVariant } from '#lib/components/ui/button/index.js';

	let {
		value,
		label = 'Copy',
		variant = 'outline',
		class: className = ''
	}: {
		value: string;
		label?: string;
		variant?: ButtonVariant;
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

<Button type="button" size="xs" {variant} class={className} onclick={copy}>
	{#if copied}
		<CheckIcon class="size-3.5" aria-hidden="true" />
		Copied
	{:else}
		<CopyIcon class="size-3.5" aria-hidden="true" />
		{label}
	{/if}
</Button>

<script lang="ts">
	import EyeIcon from '@lucide/svelte/icons/eye';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import { Button } from '#lib/components/ui/button/index.js';

	/**
	 * A `<dd>` body: a mono value that truncates, with copy (and, for secrets, a show/hide toggle).
	 * `display` lets a URL show with its password masked while the copy carries the real value.
	 */
	let {
		value,
		label,
		display,
		secret = false
	}: { value: string; label: string; display?: string; secret?: boolean } = $props();

	let shown = $state(false);
	const masked = $derived(display ?? '•'.repeat(Math.min(24, Math.max(12, value.length))));
	const text = $derived(secret && !shown ? masked : value);
</script>

<span class="flex min-w-0 items-center justify-end gap-0.5 font-mono text-xs">
	<span class="truncate" title={secret && !shown ? undefined : value}>{text}</span>
	{#if secret}
		<Button
			variant="ghost"
			size="icon-xs"
			aria-label={shown ? `Hide ${label}` : `Show ${label}`}
			onclick={() => (shown = !shown)}
		>
			{#if shown}<EyeOffIcon />{:else}<EyeIcon />{/if}
		</Button>
	{/if}
	<CopyButton {value} label="Copy {label}" iconOnly variant="ghost" size="icon-xs" />
</span>

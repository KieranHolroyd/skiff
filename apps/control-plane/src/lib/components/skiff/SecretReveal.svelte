<script lang="ts">
	import type { Snippet } from 'svelte';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import CopyButton from './CopyButton.svelte';

	/** A one-time secret (API key, token, share link, join command) that cannot be shown again. */
	let {
		title,
		description,
		value,
		copyLabel = 'Copy',
		multiline = false,
		children
	}: {
		title: string;
		description?: string;
		value: string;
		copyLabel?: string;
		multiline?: boolean;
		children?: Snippet;
	} = $props();
</script>

<section
	class="overflow-hidden rounded-xl border border-brand/35 bg-card shadow-card"
	aria-label={title}
>
	<div class="flex flex-wrap items-start justify-between gap-3 border-b border-brand/20 bg-brand-soft/60 px-4 py-3">
		<div class="flex min-w-0 items-start gap-3">
			<span class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-brand text-brand-foreground">
				<KeyRoundIcon class="size-3.5" aria-hidden="true" />
			</span>
			<div class="min-w-0">
				<p class="text-sm font-semibold">{title}</p>
				{#if description}
					<p class="text-[13px] text-muted-foreground">{description}</p>
				{/if}
			</div>
		</div>
		<CopyButton {value} label={copyLabel} variant="brand" size="sm" />
	</div>
	<div class="space-y-3 p-4">
		{#if multiline}
			<pre class="code-block whitespace-pre-wrap break-all select-all">{value}</pre>
		{:else}
			<code class="code-block block break-all select-all">{value}</code>
		{/if}
		{@render children?.()}
	</div>
</section>

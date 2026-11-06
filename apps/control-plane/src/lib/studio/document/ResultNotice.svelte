<script lang="ts">
	import XIcon from '@lucide/svelte/icons/x';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { ApplySummary } from './apply.js';

	/** The outcome of the last edit: an apply summary, or an error message. */
	let {
		summary = null,
		error = null,
		ondismiss
	}: {
		summary?: ApplySummary | null;
		error?: string | null;
		ondismiss?: () => void;
	} = $props();
</script>

{#if error || summary}
	<div class="relative">
		{#if error}
			<Notice tone="danger" title="The edit failed">{error}</Notice>
		{:else if summary}
			<Notice tone={summary.tone} title={summary.title}>
				{#if summary.details.length > 0}
					<ul class="mt-1 list-disc space-y-0.5 pl-4">
						{#each summary.details as detail, index (index)}
							<li>{detail}</li>
						{/each}
					</ul>
				{/if}
			</Notice>
		{/if}
		{#if ondismiss}
			<Button
				variant="ghost"
				size="icon-xs"
				class="absolute top-2 right-2"
				aria-label="Dismiss"
				onclick={ondismiss}
			>
				<XIcon />
			</Button>
		{/if}
	</div>
{/if}

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { section, type SectionId } from './sections.js';

	/**
	 * The heading of one Settings section. Title, icon and summary come from the section registry;
	 * pages add actions (right-aligned) and, when the summary depends on data, their own description.
	 */
	let {
		id,
		description,
		actions,
		children
	}: {
		id: SectionId;
		/** Replaces the registry summary. */
		description?: string;
		actions?: Snippet;
		/** Extra detail under the summary (badges, timestamps). */
		children?: Snippet;
	} = $props();

	const entry = $derived(section(id));
</script>

<header
	class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b pb-5"
	data-yoal-target={`settings.section.${id}`}
>
	<div class="flex min-w-0 flex-1 basis-80 items-start gap-3.5">
		<span
			class="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground shadow-xs"
			aria-hidden="true"
		>
			<entry.icon class="size-4" />
		</span>
		<div class="min-w-0 space-y-1">
			<h2 class="text-lg leading-tight font-semibold tracking-tight">{entry.label}</h2>
			<p class="max-w-2xl text-sm text-pretty text-muted-foreground">
				{description ?? entry.summary}
			</p>
			{#if children}<div class="pt-1">{@render children()}</div>{/if}
		</div>
	</div>
	{#if actions}
		<div class="flex shrink-0 flex-wrap items-center gap-2">{@render actions()}</div>
	{/if}
</header>

<script lang="ts">
	import { untrack } from 'svelte';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import {
		documentPreview,
		formatDocument,
		idLabel,
		truncatedFields,
		type MongoDocument
	} from './ejson.js';

	/**
	 * The JSON view of a page of documents: a virtualised list, each document one line until it
	 * is expanded into pretty-printed display EJSON. Heights are computed, not measured: a
	 * collapsed row is one line and an expanded one is its line count (capped, then it scrolls).
	 */
	let {
		documents,
		label,
		editable = false,
		busy = null,
		onedit,
		ondelete,
		onloadfull
	}: {
		documents: MongoDocument[];
		label: string;
		editable?: boolean;
		/** Index of the document an action is running for (shows a spinner). */
		busy?: number | null;
		onedit?: (index: number) => void;
		ondelete?: (index: number) => void;
		onloadfull?: (index: number) => void;
	} = $props();

	const HEADER = 36;
	const LINE = 18;
	const MAX_LINES = 30;
	const PADDING = 16;

	let viewport = $state<HTMLDivElement | null>(null);
	let expanded = $state<Record<number, boolean>>({});

	const texts = $derived(documents.map((doc) => formatDocument(doc)));
	const lineCounts = $derived(texts.map((text) => text.split('\n').length));

	// A new page collapses everything.
	$effect(() => {
		void documents;
		untrack(() => (expanded = {}));
	});

	function sizeOf(index: number): number {
		if (!expanded[index]) return HEADER;
		return HEADER + Math.min(lineCounts[index] ?? 1, MAX_LINES) * LINE + PADDING;
	}

	const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => viewport,
		estimateSize: () => HEADER,
		overscan: 8
	});

	// `setOptions` writes the store, so it must not be read reactively here or the effect loops.
	$effect(() => {
		const count = documents.length;
		const element = viewport;
		void expanded;
		void lineCounts;
		untrack(() => {
			$virtualizer.setOptions({ count, getScrollElement: () => element, estimateSize: sizeOf });
			$virtualizer.measure();
		});
	});

	function toggle(index: number) {
		expanded = { ...expanded, [index]: !expanded[index] };
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	bind:this={viewport}
	class="relative h-full min-h-0 overflow-auto rounded-md border font-mono text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
	role="region"
	aria-label={label}
	tabindex="0"
>
	{#if documents.length === 0}
		<p class="p-4 font-sans text-sm text-muted-foreground">No documents on this page.</p>
	{/if}
	<ul class="relative w-full" style="height: {$virtualizer.getTotalSize()}px" aria-label={label}>
		{#each $virtualizer.getVirtualItems() as item (item.key)}
			{@const doc = documents[item.index]!}
			{@const open = Boolean(expanded[item.index])}
			{@const truncated = truncatedFields(doc)}
			<li
				class="absolute top-0 left-0 w-full border-b border-border/60"
				style="height: {item.size}px; transform: translateY({item.start}px)"
			>
				<div class="flex items-center gap-1 px-1" style="height: {HEADER}px">
					<Button
						variant="ghost"
						size="icon-xs"
						aria-expanded={open}
						aria-label="{open ? 'Collapse' : 'Expand'} document {idLabel(doc.id)}"
						onclick={() => toggle(item.index)}
					>
						<ChevronRightIcon class="transition-transform {open ? 'rotate-90' : ''}" />
					</Button>
					<span class="min-w-0 flex-1 truncate" title={documentPreview(doc, 2_000)}
						>{documentPreview(doc)}</span
					>
					{#if busy === item.index}<Spinner class="size-3.5" />{/if}
					{#if truncated.length > 0 && onloadfull}
						<Button
							variant="ghost"
							size="xs"
							class="font-sans"
							onclick={() => onloadfull(item.index)}
							title="Load the full values of {truncated.join(', ')}"
						>
							Load full values
						</Button>
					{/if}
					{#if editable}
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="Edit document {idLabel(doc.id)}"
							onclick={() => onedit?.(item.index)}
						>
							<PencilIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon-xs"
							class="text-destructive"
							aria-label="Delete document {idLabel(doc.id)}"
							onclick={() => ondelete?.(item.index)}
						>
							<Trash2Icon />
						</Button>
					{/if}
				</div>
				{#if open}
					<pre
						class="mx-2 mb-2 overflow-auto rounded bg-muted/50 px-2 py-1"
						style="line-height: {LINE}px; max-height: {MAX_LINES * LINE + 8}px"
						tabindex="-1">{texts[item.index]}</pre>
				{/if}
			</li>
		{/each}
	</ul>
</div>

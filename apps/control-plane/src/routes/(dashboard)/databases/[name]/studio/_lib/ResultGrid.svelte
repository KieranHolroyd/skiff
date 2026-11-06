<script lang="ts">
	import { untrack } from 'svelte';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import type { Cell, Column } from '@skiff/studio/protocol';
	import { cellView, truncatedSuffix } from './cells.js';

	/**
	 * A virtualised, read-only result grid for the skeleton studio (plan 22 Phase 1). Only the rows
	 * on screen are in the DOM, so 10,000 rows scroll like 10. Phase 2's `StudioGrid` replaces it.
	 */
	let {
		columns,
		rows,
		label
	}: {
		columns: Column[];
		rows: Cell[][];
		/** Accessible name of the table. */
		label: string;
	} = $props();

	const ROW_HEIGHT = 28;
	let viewport = $state<HTMLDivElement | null>(null);

	const template = $derived(`3.5rem repeat(${Math.max(columns.length, 1)}, minmax(9rem, 1fr))`);
	const minWidth = $derived(`${3.5 + Math.max(columns.length, 1) * 9}rem`);

	const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => viewport,
		estimateSize: () => ROW_HEIGHT,
		overscan: 20
	});

	// `setOptions` writes the store, so it must not be read reactively here or the effect loops.
	$effect(() => {
		const count = rows.length;
		const element = viewport;
		untrack(() => $virtualizer.setOptions({ count, getScrollElement: () => element }));
	});
</script>

<!-- Focusable so keyboard users can scroll the grid (a scrollable region needs a tab stop). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	bind:this={viewport}
	class="relative h-full min-h-0 overflow-auto rounded-md border font-mono text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
	role="region"
	aria-label={label}
	tabindex="0"
>
	<div
		style="min-width: {minWidth}"
		role="table"
		aria-label={label}
		aria-rowcount={rows.length + 1}
		aria-colcount={columns.length}
	>
		<div
			role="row"
			aria-rowindex={1}
			class="sticky top-0 z-10 grid border-b bg-muted"
			style="grid-template-columns: {template}"
		>
			<span class="px-2 py-1.5 text-right text-muted-foreground" aria-hidden="true">#</span>
			{#each columns as column, index (index)}
				<span
					role="columnheader"
					class="truncate border-l px-2 py-1.5 font-medium"
					title="{column.name} · {column.nativeType}"
				>
					{column.name}
					<span class="ml-1 font-normal text-muted-foreground">{column.nativeType}</span>
				</span>
			{/each}
		</div>
		<div class="relative w-full" style="height: {$virtualizer.getTotalSize()}px">
			{#each $virtualizer.getVirtualItems() as item (item.key)}
				{@const row = rows[item.index]!}
				<div
					role="row"
					aria-rowindex={item.index + 2}
					class="absolute top-0 left-0 grid w-full border-b border-border/60 hover:bg-muted/50"
					style="grid-template-columns: {template}; height: {ROW_HEIGHT}px; transform: translateY({item.start}px)"
				>
					<span class="px-2 py-1 text-right text-muted-foreground tabular-nums" aria-hidden="true"
						>{item.index + 1}</span
					>
					{#each row as cell, index (index)}
						{@const view = cellView(cell)}
						<span role="cell" class="truncate border-l border-border/60 px-2 py-1">
							{#if view.kind === 'null'}
								<span class="text-muted-foreground italic">NULL</span>
							{:else if view.kind === 'plain'}
								<span title={view.text}>{view.text}</span>
							{:else if view.kind === 'tagged'}
								<span
									class="mr-1 rounded bg-muted px-1 text-[0.625rem] text-muted-foreground uppercase"
									>{view.tag}</span
								><span title={view.text}>{view.text}</span>
							{:else}
								<span title="Truncated">{view.text}</span>
								<span class="text-muted-foreground">{truncatedSuffix(view.bytes)}</span>
							{/if}
						</span>
					{/each}
				</div>
			{/each}
		</div>
	</div>
</div>

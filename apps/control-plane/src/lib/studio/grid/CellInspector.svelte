<script lang="ts">
	import DownloadIcon from '@lucide/svelte/icons/download';
	import type { Cell, Column } from '@skiff/studio/protocol';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { cellClipboardText, cellPretty, isTagged, rowJson, truncatedSuffix } from './cells.js';

	/** Side sheet showing the selected cell in full (plan 22): JSON pretty-printed, copyable. */
	let {
		open = $bindable(false),
		columns,
		column,
		cell,
		row,
		rowLabel,
		loading = false,
		onload
	}: {
		open?: boolean;
		columns: Column[];
		column: Column | null;
		cell: Cell | undefined;
		/** The whole row, for "Copy row as JSON"; null for a new row. */
		row: Cell[] | null;
		rowLabel: string;
		loading?: boolean;
		/** Load the full value of a truncated cell. */
		onload?: () => void;
	} = $props();

	const truncated = $derived(cell !== undefined && isTagged(cell) && cell.$t === 'truncated');
	const pretty = $derived(cell === undefined ? 'DEFAULT' : cellPretty(cell, column ?? undefined));
	const tag = $derived(cell !== undefined && isTagged(cell) ? cell.$t : null);
</script>

<Sheet.Root bind:open>
	<Sheet.Content side="right" class="w-full gap-0 sm:max-w-xl">
		<Sheet.Header class="border-b">
			<Sheet.Title class="font-mono">{column?.name ?? 'Cell'}</Sheet.Title>
			<Sheet.Description class="flex flex-wrap items-center gap-1.5">
				{#if column}
					<span class="font-mono">{column.nativeType}</span>
					<Badge variant="neutral">{column.kind}</Badge>
					{#if tag}<Badge variant="outline" class="font-mono">$t: {tag}</Badge>{/if}
					{#if column.key}<Badge variant="info">{column.key} key</Badge>{/if}
				{/if}
				<span>· {rowLabel}</span>
			</Sheet.Description>
		</Sheet.Header>

		<div class="flex flex-wrap items-center gap-2 border-b px-4 py-2">
			{#if cell !== undefined && !truncated}
				<CopyButton value={cellClipboardText(cell)} label="Copy value" size="xs" />
				{#if pretty !== cellClipboardText(cell)}
					<CopyButton value={pretty} label="Copy formatted" size="xs" />
				{/if}
			{/if}
			{#if row}
				<CopyButton value={rowJson(columns, row)} label="Copy row as JSON" size="xs" />
			{/if}
			{#if truncated && onload}
				<Button size="xs" variant="outline" disabled={loading} onclick={onload}>
					{#if loading}<Spinner class="size-3" />{:else}<DownloadIcon />{/if}
					Load full value
				</Button>
			{/if}
		</div>

		<div class="min-h-0 flex-1 overflow-auto p-4">
			{#if cell === null}
				<p class="font-mono text-sm text-muted-foreground italic">NULL</p>
			{:else if cell === undefined}
				<p class="font-mono text-sm text-muted-foreground italic">DEFAULT (set by the database)</p>
			{:else}
				<pre
					class="font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
					aria-label="Value of {column?.name ?? 'cell'}">{pretty}</pre>
				{#if truncated && cell && isTagged(cell)}
					<p class="mt-2 text-xs text-muted-foreground">
						Preview only {truncatedSuffix(cell.bytes ?? null)}. Load the full value to see or edit
						all of it.
					</p>
				{/if}
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>

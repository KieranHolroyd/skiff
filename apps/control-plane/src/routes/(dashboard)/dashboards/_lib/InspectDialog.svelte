<script lang="ts">
	/** Inspect a panel: its rows, the SQL that ran with stats, the panel JSON, and a CSV download. */
	import type { DashboardPanel, QueryResult } from '@yoal/contracts';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { formatBytes } from '../../_lib/format.js';
	import { resolveOptions } from './panel.js';
	import { toCsv, type Names } from './series.js';
	import { formatInterval } from './time.js';
	import TableViz from './viz/TableViz.svelte';

	let {
		open = $bindable(false),
		panel,
		result,
		error,
		names,
		columnUnits
	}: {
		open?: boolean;
		panel: DashboardPanel | null;
		result: QueryResult | undefined;
		error: string | null;
		names?: Names;
		columnUnits?: Record<string, string>;
	} = $props();

	let tab = $state('data');
	let formatted = $state(true);

	function download() {
		if (!result) return;
		const blob = new Blob([toCsv(result)], { type: 'text/csv' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = `${(panel?.title || 'panel').replace(/[^\w-]+/g, '-').toLowerCase()}.csv`;
		link.click();
		URL.revokeObjectURL(url);
	}

	const json = $derived(panel ? JSON.stringify(panel, null, 2) : '');
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="flex max-h-[85svh] w-[min(64rem,calc(100vw-2rem))] max-w-none flex-col sm:max-w-none"
	>
		<Dialog.Header>
			<Dialog.Title>Inspect: {panel?.title || 'panel'}</Dialog.Title>
			<Dialog.Description>
				{#if result}
					{result.rows.length.toLocaleString('en-GB')} rows · {result.stats.elapsedMs} ms ·
					{result.stats.rowsRead.toLocaleString('en-GB')} rows read · {formatBytes(
						result.stats.bytesRead
					)} read
					{#if result.intervalSeconds}· {formatInterval(result.intervalSeconds)} buckets{/if}
					{#if result.resolution}· {result.resolution} table{/if}
					{#if result.truncated}· truncated{/if}
				{:else if error}
					The query failed.
				{:else}
					No result yet.
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col">
			<Tabs.List>
				<Tabs.Trigger value="data">Data</Tabs.Trigger>
				<Tabs.Trigger value="query">Query</Tabs.Trigger>
				<Tabs.Trigger value="json">Panel JSON</Tabs.Trigger>
			</Tabs.List>
			<Tabs.Content value="data" class="flex min-h-0 flex-1 flex-col gap-2">
				<div class="flex items-center gap-2">
					<label class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<input type="checkbox" bind:checked={formatted} class="accent-brand" /> Formatted values
					</label>
					<Button variant="outline" size="sm" class="ml-auto" disabled={!result} onclick={download}>
						<DownloadIcon />Download CSV
					</Button>
				</div>
				<div class="min-h-0 flex-1 overflow-auto rounded-lg border">
					{#if result}
						<TableViz
							{result}
							options={resolveOptions(panel?.options)}
							{names}
							columnUnits={panel?.options?.unit === undefined || panel?.viz !== 'table'
								? columnUnits
								: undefined}
							raw={!formatted}
						/>
					{:else if error}
						<p class="p-4 font-mono text-xs whitespace-pre-wrap text-destructive">{error}</p>
					{/if}
				</div>
			</Tabs.Content>
			<Tabs.Content value="query" class="min-h-0 flex-1 space-y-3 overflow-auto">
				{#if result?.notice}<p class="text-xs text-warning">{result.notice}</p>{/if}
				<div class="relative">
					<pre
						class="max-h-[50svh] overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">{result?.sql ??
							error ??
							'—'}</pre>
					{#if result?.sql}<div class="absolute top-2 right-2">
							<CopyButton value={result.sql} iconOnly size="icon-sm" />
						</div>{/if}
				</div>
				{#if result}
					<dl class="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
						<div>
							<dt class="text-muted-foreground">Elapsed</dt>
							<dd class="font-mono">{result.stats.elapsedMs} ms</dd>
						</div>
						<div>
							<dt class="text-muted-foreground">Rows read</dt>
							<dd class="font-mono">{result.stats.rowsRead.toLocaleString('en-GB')}</dd>
						</div>
						<div>
							<dt class="text-muted-foreground">Bytes read</dt>
							<dd class="font-mono">{formatBytes(result.stats.bytesRead)}</dd>
						</div>
						<div>
							<dt class="text-muted-foreground">Columns</dt>
							<dd class="font-mono">
								{result.columns.map((column) => `${column.name}: ${column.type}`).join(', ')}
							</dd>
						</div>
					</dl>
				{/if}
			</Tabs.Content>
			<Tabs.Content value="json" class="relative min-h-0 flex-1 overflow-auto">
				<pre
					class="max-h-[55svh] overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs">{json}</pre>
				<div class="absolute top-2 right-2">
					<CopyButton value={json} iconOnly size="icon-sm" />
				</div>
			</Tabs.Content>
		</Tabs.Root>
	</Dialog.Content>
</Dialog.Root>

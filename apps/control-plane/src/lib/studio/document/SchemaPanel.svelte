<script lang="ts">
	import { onDestroy } from 'svelte';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import type { Cell, Column } from '@skiff/studio/protocol';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { studioStream } from '../client.js';
	import { studioErrorMessage } from './apply.js';
	import {
		formatShare,
		schemaCommand,
		SCHEMA_SAMPLE_SIZE,
		summarizeSchema,
		type SchemaSummary
	} from './schema.js';

	/**
	 * Field types and how common each is, over a fresh `$sample` of up to 1,000 documents. The
	 * sample runs as one read-only aggregate through `run` (`describe` lists the types but not
	 * their shares).
	 */
	let { database, collection }: { database: string; collection: string } = $props();

	let summary = $state.raw<SchemaSummary | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(false);
	let controller: AbortController | null = null;

	async function sample() {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		loading = true;
		error = null;
		let columns: Column[] = [];
		let rows: Cell[][] = [];
		try {
			for await (const event of studioStream(
				database,
				'run',
				{ input: schemaCommand(collection), maxRows: 10_000 },
				current.signal
			)) {
				if (event.t === 'columns') columns = event.columns;
				else if (event.t === 'rows') rows = rows.concat(event.rows);
				else if (event.t === 'error') error = event.message;
			}
			if (!error) summary = summarizeSchema(columns, rows);
		} catch (caught) {
			if (!current.signal.aborted) error = studioErrorMessage(caught);
		} finally {
			if (controller === current) {
				loading = false;
				controller = null;
			}
		}
	}

	let sampledFor: string | null = null;
	$effect(() => {
		if (sampledFor === collection) return;
		sampledFor = collection;
		summary = null;
		void sample();
	});

	onDestroy(() => controller?.abort());

	const count = new Intl.NumberFormat('en-GB');
</script>

<div class="flex flex-col gap-3">
	<div class="flex flex-wrap items-center gap-2">
		<p class="text-sm text-muted-foreground">
			{#if summary}
				{count.format(summary.fields.length)} fields in a random sample of
				{count.format(summary.sampleSize)} document{summary.sampleSize === 1 ? '' : 's'} (up to
				{count.format(SCHEMA_SAMPLE_SIZE)}).
			{:else if loading}
				Sampling up to {count.format(SCHEMA_SAMPLE_SIZE)} documents…
			{:else}
				Field types from a random sample of up to {count.format(SCHEMA_SAMPLE_SIZE)} documents.
			{/if}
		</p>
		<Button variant="outline" size="sm" class="ml-auto" onclick={sample} disabled={loading}>
			{#if loading}<Spinner />{:else}<RefreshCwIcon />{/if}
			Resample
		</Button>
	</div>

	{#if error}
		<Notice tone="danger" title="Could not sample the collection">{error}</Notice>
	{/if}

	{#if summary && summary.fields.length === 0}
		<p class="text-sm text-muted-foreground">The collection is empty.</p>
	{:else if summary}
		<div class="overflow-auto rounded-md border">
			<table class="w-full text-sm">
				<caption class="sr-only">Sampled fields of {collection}</caption>
				<thead class="bg-muted text-left text-xs">
					<tr>
						<th scope="col" class="px-3 py-2 font-medium">Field</th>
						<th scope="col" class="w-40 px-3 py-2 font-medium">In documents</th>
						<th scope="col" class="px-3 py-2 font-medium">Types</th>
					</tr>
				</thead>
				<tbody>
					{#each summary.fields as field (field.name)}
						<tr class="border-t align-top">
							<th scope="row" class="px-3 py-2 text-left font-mono text-xs font-normal break-all">
								{field.name}
							</th>
							<td class="px-3 py-2">
								<div class="flex items-center gap-2">
									<div
										class="h-1.5 w-20 overflow-hidden rounded bg-muted"
										role="presentation"
									>
										<div class="h-full bg-primary" style="width: {field.share * 100}%"></div>
									</div>
									<span class="text-xs tabular-nums">{formatShare(field.share)}</span>
								</div>
							</td>
							<td class="px-3 py-2">
								<div class="flex flex-wrap gap-1">
									{#each field.types as type (type.type)}
										<Badge variant="secondary" class="font-mono">
											{type.type}
											<span class="text-muted-foreground tabular-nums"
												>{formatShare(type.share)}</span
											>
										</Badge>
									{/each}
									{#if field.share < 1}
										<Badge variant="outline" class="font-mono text-muted-foreground">
											missing
											<span class="tabular-nums">{formatShare(1 - field.share)}</span>
										</Badge>
									{/if}
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

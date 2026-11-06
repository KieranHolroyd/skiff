<script lang="ts">
	/**
	 * What can be queried: builder datasets with their measures and dimensions, and (for SQL
	 * users) the ClickHouse tables with columns, row counts and sizes. Clicking a name inserts it.
	 */
	import type { ObservabilitySchema } from '@skiff/contracts';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { formatBytes } from '../../_lib/format.js';
	import { formatValue } from './units.js';

	let {
		schema,
		oninsert
	}: { schema: ObservabilitySchema | undefined; oninsert?: (text: string) => void } = $props();

	let filter = $state('');
	const match = (text: string) => !filter || text.toLowerCase().includes(filter.toLowerCase());
</script>

<div class="space-y-3 text-xs">
	<input
		bind:value={filter}
		placeholder="Filter fields and tables"
		aria-label="Filter schema"
		class="h-7 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
	/>
	<section>
		<h3 class="mb-1 font-semibold tracking-wide text-muted-foreground uppercase">Datasets</h3>
		{#each schema?.datasets ?? [] as dataset (dataset.name)}
			<details class="group rounded-md" open={Boolean(filter)}>
				<summary
					class="flex cursor-pointer list-none items-center gap-1 rounded-md px-1 py-1 hover:bg-muted"
				>
					<ChevronRightIcon class="size-3 transition-transform group-open:rotate-90" />
					<span class="font-medium">{dataset.label}</span>
					<span class="ml-auto font-mono text-muted-foreground">{dataset.name}</span>
				</summary>
				<ul class="ml-4 space-y-0.5 border-l py-1 pl-2">
					{#each dataset.measures.filter((item) => match(item.name) || match(item.label)) as measure (measure.name)}
						<li>
							<button
								type="button"
								class="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-muted"
								title={measure.description ?? measure.label}
								onclick={() => oninsert?.(measure.name)}
							>
								<span class="font-mono">{measure.name}</span>
								<span class="ml-auto text-[10px] text-muted-foreground"
									>{measure.kind} · {measure.unit}</span
								>
							</button>
						</li>
					{/each}
					{#each dataset.dimensions.filter((item) => match(item.name) || match(item.label)) as dimension (dimension.name)}
						<li>
							<button
								type="button"
								class="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-muted"
								title={dimension.label}
								onclick={() => oninsert?.(dimension.name)}
							>
								<span class="font-mono text-info">{dimension.name}</span>
								<span class="ml-auto text-[10px] text-muted-foreground">dimension</span>
							</button>
						</li>
					{/each}
				</ul>
			</details>
		{/each}
	</section>
	{#if schema?.canUseSql && schema.tables.length > 0}
		<section>
			<h3 class="mb-1 font-semibold tracking-wide text-muted-foreground uppercase">Tables</h3>
			{#each schema.tables.filter((table) => match(table.name) || table.columns.some( (column) => match(column.name) )) as table (table.name)}
				<details class="group" open={Boolean(filter)}>
					<summary
						class="flex cursor-pointer list-none items-center gap-1 rounded-md px-1 py-1 hover:bg-muted"
					>
						<ChevronRightIcon class="size-3 transition-transform group-open:rotate-90" />
						<button
							type="button"
							class="font-mono font-medium hover:underline"
							onclick={(event) => (event.preventDefault(), oninsert?.(table.name))}
							>{table.name}</button
						>
						<span class="ml-auto text-muted-foreground" title={table.engine}
							>{formatValue(table.rows, 'short')} rows · {formatBytes(table.bytes)}</span
						>
					</summary>
					<ul class="ml-4 space-y-0.5 border-l py-1 pl-2">
						{#each table.columns as column (column.name)}
							<li>
								<button
									type="button"
									class="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-muted"
									title={column.comment || column.type}
									onclick={() => oninsert?.(column.name)}
								>
									<span class="font-mono">{column.name}</span>
									<span class="ml-auto truncate text-[10px] text-muted-foreground"
										>{column.type}</span
									>
								</button>
							</li>
						{/each}
					</ul>
				</details>
			{/each}
		</section>
	{/if}
	{#if schema}
		<p class="text-muted-foreground">
			Minute data is kept {schema.retention.minuteHours} h, hourly data {schema.retention.hourDays} days.
		</p>
	{/if}
</div>

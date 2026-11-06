<script lang="ts">
	/**
	 * Query rows as a sortable table. Numbers are unit-formatted (time columns as UTC timestamps,
	 * id columns as display names) and the sort works on the raw values.
	 */
	import type { QueryResult } from '@skiff/contracts';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import type { ResolvedOptions } from '../panel.js';
	import { idKindOf, labelValue, type Names } from '../series.js';
	import { formatTimestamp } from '../time.js';
	import { formatValue, thresholdColor } from '../units.js';

	let {
		result,
		options,
		names,
		columnUnits,
		height,
		raw = false
	}: {
		result: QueryResult;
		options: ResolvedOptions;
		names?: Names;
		/** Per-column units (builder metrics); used instead of the panel unit for those columns. */
		columnUnits?: Record<string, string>;
		height?: number;
		/** Inspect view: show values exactly as returned. */
		raw?: boolean;
	} = $props();

	const LIMIT = 1_000;
	let sort = $state<{ index: number; desc: boolean } | null>(null);

	const rows = $derived.by(() => {
		const list = result.rows.slice();
		if (sort) {
			const { index, desc } = sort;
			list.sort((a, b) => {
				const x = a[index];
				const y = b[index];
				if (x === y) return 0;
				if (x === null || x === undefined) return 1;
				if (y === null || y === undefined) return -1;
				const order =
					typeof x === 'number' && typeof y === 'number'
						? x - y
						: String(x).localeCompare(String(y), undefined, { numeric: true });
				return desc ? -order : order;
			});
		}
		return list.slice(0, LIMIT);
	});

	function toggle(index: number) {
		const numeric = result.columns[index]?.kind === 'number';
		if (!sort || sort.index !== index) sort = { index, desc: numeric };
		else if (sort.desc === numeric) sort = { index, desc: !numeric };
		else sort = null;
	}

	function display(value: unknown, index: number): string {
		const column = result.columns[index]!;
		if (raw) return value === null || value === undefined ? 'null' : String(value);
		if (column.kind === 'time' && typeof value === 'number') return formatTimestamp(value);
		if (column.kind === 'number' && typeof value === 'number') {
			return formatValue(value, columnUnits?.[column.name] ?? options.unit, options.decimals);
		}
		return labelValue(column.name, value, names);
	}
</script>

<div class="overflow-auto rounded-md" style:max-height={height ? `${height}px` : undefined}>
	<table class="w-full text-xs">
		<thead class="sticky top-0 z-10 bg-muted/80 backdrop-blur">
			<tr>
				{#each result.columns as column, index (index)}
					<th
						class="px-2 py-1.5 font-medium whitespace-nowrap text-muted-foreground {column.kind ===
						'number'
							? 'text-right'
							: 'text-left'}"
						aria-sort={sort?.index === index ? (sort.desc ? 'descending' : 'ascending') : undefined}
					>
						<button
							type="button"
							class="inline-flex items-center gap-1 rounded px-0.5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
							title={column.type}
							onclick={() => toggle(index)}
						>
							{idKindOf(column.name) && !raw ? column.name.replace(/_id$/, '') : column.name}
							{#if sort?.index === index}
								{#if sort.desc}<ArrowDownIcon class="size-3" />{:else}<ArrowUpIcon
										class="size-3"
									/>{/if}
							{/if}
						</button>
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each rows as row, rowIndex (rowIndex)}
				<tr class="border-t border-border/60 hover:bg-muted/40">
					{#each row as value, index (index)}
						{@const column = result.columns[index]}
						<td
							class="px-2 py-1 whitespace-nowrap {column?.kind === 'number'
								? 'text-right font-mono tabular-nums'
								: column?.kind === 'time'
									? 'font-mono text-muted-foreground'
									: ''}"
							style:color={column?.kind === 'number' && typeof value === 'number' && !raw
								? thresholdColor(value, options.thresholds)
								: undefined}
						>
							{display(value, index)}
						</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
	{#if result.rows.length > LIMIT}
		<p class="px-2 py-1.5 text-xs text-muted-foreground">
			Showing the first {LIMIT.toLocaleString('en-GB')} of {result.rows.length.toLocaleString(
				'en-GB'
			)} rows.
		</p>
	{/if}
</div>

<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { RowData } from '@tanstack/svelte-table';

	/** One column of a `DataTable`. Markup stays in snippets; Table owns sorting and search. */
	export interface DataColumn<T extends RowData> {
		id: string;
		/** Visible header text; leave empty for an actions column and set `srHeader`. */
		header: string;
		srHeader?: string;
		/** The value sorted and searched on. Omit for columns that are display-only. */
		value?: (row: T) => string | number | null | undefined;
		/** Defaults to true when `value` is set. */
		sortable?: boolean;
		/** Include this column in the search box. Defaults to true for string values. */
		searchable?: boolean;
		/** Click once for descending (newest, largest) first. Good for dates and sizes. */
		descFirst?: boolean;
		cell: Snippet<[T]>;
		/** Custom header content (e.g. a select-all checkbox); replaces `header` text. */
		head?: Snippet;
		/** Cell classes, e.g. `hidden md:table-cell` or `pr-4 text-right`. */
		class?: string;
		/** Header classes; defaults to `class` minus text styling. */
		headClass?: string;
	}

	export interface DataSort {
		id: string;
		desc: boolean;
	}
</script>

<script lang="ts" generics="T extends RowData">
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import {
		columnFilteringFeature,
		createFilteredRowModel,
		createSortedRowModel,
		createTable,
		filterFn_includesString,
		globalFilteringFeature,
		rowSortingFeature,
		sortFn_alphanumeric,
		sortFn_basic,
		sortFn_text,
		tableFeatures,
		type SortingState
	} from '@tanstack/svelte-table';
	import * as Table from '#lib/components/ui/table/index.js';

	/**
	 * A sortable, searchable table on TanStack Table. Rows render through each column's snippet,
	 * so pages keep full control of markup; the table owns order and filtering. Search text is
	 * bound from outside, so it can live in whatever toolbar the page already has.
	 */
	let {
		rows,
		columns,
		rowId,
		search = '',
		sort = null,
		label,
		rowClass,
		headerClass = 'bg-muted/45',
		onmatch,
		onrows,
		selected,
		empty
	}: {
		rows: T[];
		columns: DataColumn<T>[];
		rowId: (row: T) => string;
		search?: string;
		/** Initial order; the reader can change it by clicking headers. */
		sort?: DataSort | null;
		/** Accessible name for the table. */
		label: string;
		rowClass?: (row: T) => string;
		headerClass?: string;
		/** Called with the number of rows left after the search, for "3 matches" readouts. */
		onmatch?: (count: number) => void;
		/** Called with the visible rows in display order (after search and sort). */
		onrows?: (rows: T[]) => void;
		/** Marks a row as selected (`data-state="selected"`) for styling. */
		selected?: (row: T) => boolean;
		/** Shown in the body when the search matches nothing. */
		empty?: Snippet<[string]>;
	} = $props();

	const features = tableFeatures({
		rowSortingFeature,
		sortedRowModel: createSortedRowModel(),
		sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, basic: sortFn_basic },
		columnFilteringFeature,
		globalFilteringFeature,
		filteredRowModel: createFilteredRowModel(),
		filterFns: { includesString: filterFn_includesString }
	});

	// svelte-ignore state_referenced_locally
	let sorting = $state<SortingState>(sort ? [sort] : []);

	const searchable = $derived(
		new Set(
			columns
				.filter((column) => column.searchable ?? column.value !== undefined)
				.map((column) => column.id)
		)
	);

	const definitions = $derived(
		columns.map((column) => ({
			id: column.id,
			accessorFn: (row: T) => column.value?.(row) ?? undefined,
			enableSorting: column.sortable ?? column.value !== undefined,
			sortDescFirst: column.descFirst ?? false,
			sortUndefined: 'last' as const
		}))
	);

	const table = createTable({
		features,
		get columns() {
			return definitions;
		},
		get data() {
			return rows;
		},
		getRowId: (row: T) => rowId(row),
		globalFilterFn: 'includesString',
		getColumnCanGlobalFilter: (column) => searchable.has(column.id),
		enableSortingRemoval: true,
		state: {
			get sorting() {
				return sorting;
			},
			get globalFilter() {
				return search;
			}
		},
		onSortingChange: (next) => {
			sorting = typeof next === 'function' ? next(sorting) : next;
		}
	});

	const visible = $derived(table.getRowModel().rows);
	$effect(() => {
		onmatch?.(visible.length);
		onrows?.(visible.map((row) => row.original));
	});

	function headClassFor(column: DataColumn<T>): string {
		return (
			column.headClass ?? (column.class ?? '').replace(/\b(font-mono|text-xs|tabular-nums)\b/g, '')
		);
	}
</script>

<Table.Root aria-label={label}>
	<Table.Header class={headerClass}>
		<Table.Row>
			{#each columns as column (column.id)}
				{@const state = table.getColumn(column.id)}
				{@const direction = state?.getIsSorted() ?? false}
				<Table.Head
					class={headClassFor(column)}
					aria-sort={direction === 'asc'
						? 'ascending'
						: direction === 'desc'
							? 'descending'
							: undefined}
				>
					{#if column.head}
						{@render column.head()}
					{:else if state?.getCanSort()}
						<button
							type="button"
							class="-mx-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none {direction
								? 'text-foreground'
								: ''}"
							onclick={state.getToggleSortingHandler()}
						>
							{column.header}
							{#if direction === 'asc'}
								<ArrowUpIcon class="size-3.5" aria-hidden="true" />
							{:else if direction === 'desc'}
								<ArrowDownIcon class="size-3.5" aria-hidden="true" />
							{:else}
								<ChevronsUpDownIcon class="size-3.5 opacity-40" aria-hidden="true" />
							{/if}
						</button>
					{:else if column.header}
						{column.header}
					{:else if column.srHeader}
						<span class="sr-only">{column.srHeader}</span>
					{/if}
				</Table.Head>
			{/each}
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#each visible as row (row.id)}
			<Table.Row
				class={rowClass?.(row.original) ?? 'group'}
				data-state={selected?.(row.original) ? 'selected' : undefined}
			>
				{#each columns as column (column.id)}
					<Table.Cell class={column.class}>{@render column.cell(row.original)}</Table.Cell>
				{/each}
			</Table.Row>
		{:else}
			<Table.Row>
				<Table.Cell
					colspan={columns.length}
					class="py-10 text-center text-sm text-muted-foreground"
				>
					{#if empty}
						{@render empty(search)}
					{:else if search}
						Nothing matches “{search}”.
					{:else}
						Nothing to show.
					{/if}
				</Table.Cell>
			</Table.Row>
		{/each}
	</Table.Body>
</Table.Root>

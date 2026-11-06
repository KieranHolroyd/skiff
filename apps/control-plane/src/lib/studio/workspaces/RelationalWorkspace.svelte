<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { createQuery } from '@tanstack/svelte-query';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import Columns3Icon from '@lucide/svelte/icons/columns-3';
	import ListFilterIcon from '@lucide/svelte/icons/list-filter';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import TableIcon from '@lucide/svelte/icons/table';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import XIcon from '@lucide/svelte/icons/x';
	import type {
		BrowseQuery,
		Cell,
		Column,
		ObjectRef,
		RowChange,
		SchemaChangeInput
	} from '@skiff/studio/protocol';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import CodeBlock from '../../../routes/(dashboard)/_lib/CodeBlock.svelte';
	import { StudioCallError, studioCall, studioStream } from '../client.js';
	import {
		buildFilter,
		filterOpLabels,
		filterOpsFor,
		nextSort,
		opNeedsValue,
		selectStatement,
		type FilterDraft
	} from '../grid/browse.js';
	import { isTruncated } from '../grid/cells.js';
	import StudioGrid from '../grid/StudioGrid.svelte';
	import { getStudioShell } from '../shell/context.js';
	import StudioErrorNotice from '../shell/StudioErrorNotice.svelte';
	import { formatBytes } from '../shell/tree.js';
	import { canAlter } from '../structure/changes.js';
	import ColumnDialog from '../structure/ColumnDialog.svelte';
	import IndexDialog from '../structure/IndexDialog.svelte';
	import ObjectActions from '../structure/ObjectActions.svelte';
	import { AlterReview } from '../structure/review.svelte.js';
	import ReviewDialog from '../structure/ReviewDialog.svelte';
	import type { WorkspaceProps } from '../ui-types.js';

	/**
	 * One table or view (plan 22): a Data tab (filter builder, sort, cursor paging, inline edits)
	 * and a Structure tab (columns, indexes, foreign keys, DDL).
	 */
	let { database, info, object, onquery }: WorkspaceProps = $props();

	const PAGE_SIZE = 100;
	const shell = getStudioShell();
	const ref = $derived<ObjectRef>({ path: object.path, kind: object.kind });
	const numberFormat = new Intl.NumberFormat('en-GB');

	// `info` is fetched once per session, so its expiry identifies the session in cache keys.
	const describe = createQuery(() => ({
		queryKey: ['studio-describe', database, info.expiresAt, ...object.path],
		queryFn: ({ signal }) => studioCall(database, 'describe', { object: ref }, signal),
		staleTime: Infinity,
		retry: false
	}));
	const description = $derived(describe.data);

	let tab = $state('data');

	// --- browse --------------------------------------------------------------------------------

	let columns = $state.raw<Column[]>([]);
	let rows = $state.raw<Cell[][]>([]);
	/** `cursors[i]` fetched page i + 1; the last entry is the page on screen. */
	let cursors = $state<(string | undefined)[]>([undefined]);
	let next = $state<string | null>(null);
	let estimate = $state<number | null>(null);
	let ms = $state<number | null>(null);
	let truncated = $state(false);
	let browsing = $state(false);
	let browseError = $state<unknown>(null);
	// Replaced whole on every change, never mutated.
	let sort = $state.raw<BrowseQuery['sort']>([]);
	let filter = $state.raw<BrowseQuery['filter']>([]);
	let controller: AbortController | null = null;

	async function browse(cursor: string | undefined) {
		controller?.abort();
		const mine = new AbortController();
		controller = mine;
		browsing = true;
		browseError = null;
		let nextColumns: Column[] | null = null;
		let nextRows: Cell[][] = [];
		let first = true;
		try {
			for await (const event of studioStream(
				database,
				'browse',
				{
					object: ref,
					query: {
						limit: PAGE_SIZE,
						sort,
						filter,
						...(cursor ? { cursor } : {})
					}
				},
				mine.signal
			)) {
				if (event.t === 'columns') nextColumns = event.columns;
				else if (event.t === 'rows') {
					nextRows = nextRows.concat(event.rows);
					// Show the first batch as soon as it lands; later batches extend it.
					if (first && nextColumns) {
						columns = nextColumns;
						first = false;
					}
					rows = nextRows;
				} else if (event.t === 'page') {
					next = event.next;
					estimate = event.estimate ?? estimate;
				} else if (event.t === 'error')
					browseError = new StudioCallError(
						event.code as ConstructorParameters<typeof StudioCallError>[0],
						event.message,
						0
					);
				else if (event.t === 'done') {
					ms = event.ms;
					truncated = event.truncated;
				}
			}
			if (nextColumns) columns = nextColumns;
			rows = nextRows;
		} catch (caught) {
			if (!mine.signal.aborted) browseError = caught;
		} finally {
			if (controller === mine) {
				browsing = false;
				controller = null;
			}
		}
	}

	function firstPage() {
		cursors = [undefined];
		next = null;
		estimate = null;
		void browse(undefined);
	}
	function nextPage() {
		if (!next) return;
		const cursor = next;
		cursors = [...cursors, cursor];
		void browse(cursor);
	}
	function previousPage() {
		if (cursors.length < 2) return;
		cursors = cursors.slice(0, -1);
		void browse(cursors.at(-1));
	}
	function reload() {
		void browse(cursors.at(-1));
	}

	// Load the first page once, when the tab opens.
	untrack(() => firstPage());
	onDestroy(() => controller?.abort());

	const page = $derived(cursors.length);
	const firstRow = $derived((page - 1) * PAGE_SIZE + 1);

	function onsort(column: string, additive: boolean) {
		sort = nextSort(sort, column, additive);
		firstPage();
	}

	// --- filter builder ------------------------------------------------------------------------

	let showFilter = $state(false);
	let drafts = $state<FilterDraft[]>([]);
	let filterError = $state<{ message: string; index: number } | null>(null);
	const filterColumns = $derived(description?.columns ?? columns);

	function addCondition() {
		const column = filterColumns[0];
		if (!column) return;
		drafts = [...drafts, { column: column.name, op: filterOpsFor(column)[0] ?? 'eq', value: '' }];
		showFilter = true;
	}

	function changeColumn(index: number, name: string) {
		const column = filterColumns.find((candidate) => candidate.name === name);
		const draft = drafts[index];
		if (!column || !draft) return;
		const ops = filterOpsFor(column);
		draft.column = name;
		if (!ops.includes(draft.op)) draft.op = ops[0] ?? 'is-null';
	}

	function applyFilter() {
		const built = buildFilter(filterColumns, $state.snapshot(drafts) as FilterDraft[]);
		if (!built.ok) {
			filterError = { message: built.error, index: built.index };
			return;
		}
		filterError = null;
		filter = built.filter;
		firstPage();
	}

	function clearFilter() {
		drafts = [];
		filterError = null;
		if (filter.length > 0) {
			filter = [];
			firstPage();
		}
	}

	function filterKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			applyFilter();
		}
	}

	// --- editing -------------------------------------------------------------------------------

	const keyColumns = $derived(description?.primaryKey ?? []);
	const editable = $derived(Boolean(description?.editable) && !info.readOnly);

	async function onapply(changes: RowChange[]) {
		const result = await studioCall(database, 'apply', { object: ref, changes });
		// On a conflict the grid keeps the tray and marks the rows; the page stays as loaded.
		if (result.conflicts.length === 0) reload();
		return result;
	}

	async function onloadvalue(row: Cell[], column: string): Promise<Cell> {
		if (keyColumns.length === 0)
			throw new Error('This object has no primary key, so the full value cannot be fetched.');
		const key: Record<string, Cell> = {};
		for (const name of keyColumns) {
			const index = columns.findIndex((candidate) => candidate.name === name);
			const cell = row[index];
			if (index < 0 || cell === undefined || isTruncated(cell))
				throw new Error(`The key column ${name} is not loaded.`);
			key[name] = cell;
		}
		const result = await studioCall(database, 'value', { object: ref, key, column });
		return result.cell;
	}

	function queryThis() {
		onquery?.(selectStatement(object.path, info.capabilities.dialect));
	}

	// --- structure -----------------------------------------------------------------------------

	async function openReference(path: string[]) {
		if (!shell) return;
		const opened = await shell.openPath(path);
		if (!opened) toast.info(`${path.join('.')} isn't in the object tree.`);
	}

	// --- structure edits ------------------------------------------------------------------------

	const review = new AlterReview(() => database);
	/** Column and index edits apply to tables, not views. */
	const isTable = $derived(object.kind === 'table');
	const can = $derived({
		addColumn: isTable && canAlter(info, 'add-column'),
		editColumn: isTable && (canAlter(info, 'alter-column') || canAlter(info, 'rename-column')),
		dropColumn: isTable && canAlter(info, 'drop-column'),
		createIndex: isTable && canAlter(info, 'create-index'),
		dropIndex: isTable && canAlter(info, 'drop-index')
	});
	const columnActions = $derived(can.editColumn || can.dropColumn);
	let columnDialog = $state(false);
	let editingColumn = $state<Column | null>(null);
	let indexDialog = $state(false);

	/** Review and run `changes`; then re-read the structure and the rows on screen. */
	async function alter(title: string, changes: SchemaChangeInput[], confirmLabel: string, done: string) {
		const results = await review.start({ title, changes, confirmLabel });
		if (!results) return;
		if (results.length === changes.length) toast.success(done);
		void describe.refetch();
		firstPage();
		shell?.structureChanged({ kind: 'changed' });
	}

	function addColumn() {
		editingColumn = null;
		columnDialog = true;
	}

	function editColumn(column: Column) {
		editingColumn = column;
		columnDialog = true;
	}

	function columnChanges(changes: SchemaChangeInput[]) {
		const column = editingColumn;
		if (!column) {
			const added = changes[0]?.op === 'add-column' ? changes[0].column.name : 'the column';
			return void alter(`Add column ${added}`, changes, 'Add column', `Added ${added}.`);
		}
		void alter(`Change column ${column.name}`, changes, 'Apply', `Changed ${column.name}.`);
	}

	function dropColumn(column: Column) {
		void alter(
			`Drop column ${column.name}`,
			[{ op: 'drop-column', object: ref, column: column.name }],
			'Drop column',
			`Dropped ${column.name}.`
		);
	}

	function dropIndex(name: string) {
		void alter(`Drop index ${name}`, [{ op: 'drop-index', object: ref, name }], 'Drop index', `Dropped ${name}.`);
	}
</script>

<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col gap-0">
	<div class="flex flex-wrap items-center gap-2 border-b px-3">
		<Tabs.List variant="line" class="h-9">
			<Tabs.Trigger value="data" class="flex-none"><TableIcon />Data</Tabs.Trigger>
			<Tabs.Trigger value="structure" class="flex-none"><Columns3Icon />Structure</Tabs.Trigger>
		</Tabs.List>
		<span class="truncate font-mono text-xs text-muted-foreground" title={object.path.join('.')}
			>{object.path.join('.')}</span
		>
		{#if object.kind !== 'table'}
			<Badge variant="neutral">{object.kind}</Badge>
		{/if}
		<div class="ml-auto flex items-center gap-1.5 py-1">
			<Button size="xs" variant="ghost" onclick={queryThis} disabled={!onquery}>
				<SquareTerminalIcon />Query this table
			</Button>
			<ObjectActions {database} {info} {object} ontruncated={firstPage} />
		</div>
	</div>

	<!-- Data ------------------------------------------------------------------------------------ -->
	<Tabs.Content value="data" class="flex min-h-0 flex-1 flex-col gap-2 p-3">
		<div class="flex flex-wrap items-center gap-2">
			<Button
				size="xs"
				variant={filter.length > 0 ? 'secondary' : 'outline'}
				aria-expanded={showFilter}
				aria-controls="filter-{object.path.join('.')}"
				onclick={() => {
					showFilter = !showFilter;
					if (showFilter && drafts.length === 0) addCondition();
				}}
			>
				<ListFilterIcon />Filter{filter.length > 0 ? ` (${filter.length})` : ''}
			</Button>
			{#if sort.length > 0}
				<span class="flex items-center gap-1 text-xs text-muted-foreground">
					Sorted by
					{#each sort as entry, index (entry.column)}
						<span class="font-mono text-foreground"
							>{entry.column} {entry.dir}{index < sort.length - 1 ? ',' : ''}</span
						>
					{/each}
					<Button
						size="icon-xs"
						variant="ghost"
						aria-label="Clear sort"
						onclick={() => {
							sort = [];
							firstPage();
						}}><XIcon /></Button
					>
				</span>
			{/if}
			<div class="ml-auto flex items-center gap-2">
				{#if browsing}<Spinner class="size-3.5" />{/if}
				<Button size="icon-xs" variant="ghost" aria-label="Reload rows" title="Reload rows" disabled={browsing} onclick={reload}>
					<RefreshCwIcon />
				</Button>
			</div>
		</div>

		{#if showFilter}
			<div
				id="filter-{object.path.join('.')}"
				class="space-y-2 rounded-md border bg-muted/30 p-2"
				role="group"
				aria-label="Filter rows"
			>
				{#each drafts as draft, index (index)}
					{@const column = filterColumns.find((candidate) => candidate.name === draft.column)}
					{@const ops = column ? filterOpsFor(column) : []}
					<div class="flex flex-wrap items-center gap-1.5">
						<span class="w-10 text-right text-xs text-muted-foreground">{index === 0 ? 'Where' : 'and'}</span>
						<NativeSelect.Root
							size="sm"
							aria-label="Column"
							value={draft.column}
							onchange={(event) => changeColumn(index, event.currentTarget.value)}
						>
							{#each filterColumns as option (option.name)}
								<NativeSelect.Option value={option.name}>{option.name}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
						<NativeSelect.Root size="sm" aria-label="Operator" bind:value={draft.op}>
							{#each ops as op (op)}
								<NativeSelect.Option value={op}>{filterOpLabels[op]}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
						{#if opNeedsValue(draft.op)}
							{#if column?.kind === 'boolean'}
								<NativeSelect.Root size="sm" aria-label="Value" bind:value={draft.value}>
									<NativeSelect.Option value="">Choose…</NativeSelect.Option>
									<NativeSelect.Option value="true">true</NativeSelect.Option>
									<NativeSelect.Option value="false">false</NativeSelect.Option>
								</NativeSelect.Root>
							{:else}
								<input
									bind:value={draft.value}
									onkeydown={filterKeydown}
									aria-label="Value"
									aria-invalid={filterError?.index === index ? true : undefined}
									placeholder={draft.op === 'in'
										? 'a, b, c'
										: draft.op === 'like' || draft.op === 'ilike'
											? '%pattern%'
											: (column?.nativeType ?? 'value')}
									spellcheck={false}
									class="h-7 w-48 min-w-0 rounded-md border border-input bg-background px-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive"
								/>
							{/if}
						{/if}
						<Button
							size="icon-xs"
							variant="ghost"
							aria-label="Remove condition"
							onclick={() => (drafts = drafts.filter((_, at) => at !== index))}><XIcon /></Button
						>
					</div>
				{/each}
				{#if filterError}
					<p class="text-xs text-destructive" role="alert">{filterError.message}</p>
				{/if}
				<div class="flex flex-wrap items-center gap-1.5">
					<Button size="xs" variant="ghost" onclick={addCondition} disabled={filterColumns.length === 0}>
						<PlusIcon />Add condition
					</Button>
					<div class="ml-auto flex gap-1.5">
						<Button size="xs" variant="ghost" onclick={clearFilter}>Clear</Button>
						<Button size="xs" onclick={applyFilter}>Apply filter</Button>
					</div>
				</div>
			</div>
		{/if}

		{#if description && !description.editable && description.reason}
			<Notice tone="info" title="Read-only object">{description.reason}</Notice>
		{:else if description?.editable && info.readOnly && keyColumns.length > 0}
			<p class="text-xs text-muted-foreground">
				This session is read-only. Enable writes in the header to edit rows.
			</p>
		{/if}

		{#if browseError}
			<StudioErrorNotice error={browseError} onretry={reload} />
		{/if}

		<div class="min-h-0 flex-1">
			{#if columns.length > 0}
				<StudioGrid
					{columns}
					{rows}
					label="Rows of {object.path.join('.')}"
					{keyColumns}
					{editable}
					{onapply}
					{onloadvalue}
					loading={browsing}
					{sort}
					{onsort}
				>
					{#snippet footer()}
						<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
							<span role="status">
								{#if rows.length > 0}
									Rows {numberFormat.format(firstRow)}–{numberFormat.format(firstRow + rows.length - 1)}
								{:else}
									No rows on this page
								{/if}
								{#if estimate !== null}
									of about {numberFormat.format(estimate)}
								{/if}
								{#if ms !== null}· {numberFormat.format(ms)} ms{/if}
								{#if truncated}· cut at the session's size limit{/if}
							</span>
							<div class="ml-auto flex items-center gap-1.5">
								<span>Page {page}</span>
								<Button
									size="xs"
									variant="outline"
									aria-label="Previous page"
									disabled={browsing || page < 2}
									onclick={previousPage}><ChevronLeftIcon />Previous</Button
								>
								<Button
									size="xs"
									variant="outline"
									aria-label="Next page"
									disabled={browsing || next === null}
									onclick={nextPage}>Next<ChevronRightIcon /></Button
								>
							</div>
						</div>
					{/snippet}
				</StudioGrid>
			{:else if browsing}
				<div class="flex items-center gap-2 p-4 text-sm text-muted-foreground" role="status">
					<Spinner class="size-4" />Loading rows…
				</div>
			{/if}
		</div>
	</Tabs.Content>

	<!-- Structure ------------------------------------------------------------------------------- -->
	<Tabs.Content value="structure" class="min-h-0 flex-1 overflow-auto p-3">
		{#if describe.isPending}
			<div class="flex items-center gap-2 p-4 text-sm text-muted-foreground" role="status">
				<Spinner class="size-4" />Reading the structure…
			</div>
		{:else if describe.isError}
			<StudioErrorNotice error={describe.error} onretry={() => describe.refetch()} />
		{:else if description}
			<div class="space-y-6">
				{#if description.estimate?.rows !== undefined || description.estimate?.bytes !== undefined}
					<p class="text-xs text-muted-foreground">
						{#if description.estimate?.rows !== undefined}About {numberFormat.format(description.estimate.rows)} rows{/if}
						{#if description.estimate?.bytes !== undefined}· {formatBytes(description.estimate.bytes)} on disk{/if}
					</p>
				{/if}

				<section aria-labelledby="columns-{object.path.join('.')}" class="space-y-2">
					<div class="flex items-center gap-2">
						<h3 id="columns-{object.path.join('.')}" class="text-sm font-medium">
							Columns <span class="text-muted-foreground">{description.columns.length}</span>
						</h3>
						{#if can.addColumn}
							<Button size="xs" variant="outline" class="ml-auto" onclick={addColumn}><PlusIcon />Add column</Button>
						{/if}
					</div>
					<div class="overflow-hidden rounded-md border">
						<Table.Root class="text-xs">
							<Table.Header>
								<Table.Row>
									<Table.Head>Name</Table.Head>
									<Table.Head>Type</Table.Head>
									<Table.Head>Nullable</Table.Head>
									<Table.Head>Default</Table.Head>
									<Table.Head>Key</Table.Head>
									<Table.Head>Editable</Table.Head>
									{#if columnActions}<Table.Head><span class="sr-only">Actions</span></Table.Head>{/if}
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each description.columns as column (column.name)}
									<Table.Row>
										<Table.Cell class="font-mono font-medium">{column.name}</Table.Cell>
										<Table.Cell class="font-mono text-muted-foreground">{column.nativeType}</Table.Cell>
										<Table.Cell>{column.nullable === false ? 'No' : 'Yes'}</Table.Cell>
										<Table.Cell class="max-w-48 truncate font-mono text-muted-foreground" title={column.default ?? undefined}
											>{column.default ?? ''}</Table.Cell
										>
										<Table.Cell>
											{#if description.primaryKey?.includes(column.name)}
												<Badge variant="warning">primary</Badge>
											{:else if column.key}
												<Badge variant="info">{column.key}</Badge>
											{/if}
										</Table.Cell>
										<Table.Cell>{column.editable === false ? 'No' : 'Yes'}</Table.Cell>
										{#if columnActions}
											<Table.Cell class="w-px py-0 whitespace-nowrap">
												{#if can.editColumn}
													<Button size="icon-xs" variant="ghost" aria-label="Edit column {column.name}" title="Edit column" onclick={() => editColumn(column)}
														><PencilIcon /></Button
													>
												{/if}
												{#if can.dropColumn}
													<Button
														size="icon-xs"
														variant="ghost"
														class="text-destructive"
														aria-label="Drop column {column.name}"
														title="Drop column"
														disabled={description.columns.length === 1}
														onclick={() => dropColumn(column)}><Trash2Icon /></Button
													>
												{/if}
											</Table.Cell>
										{/if}
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</div>
				</section>

				<section aria-labelledby="indexes-{object.path.join('.')}" class="space-y-2">
					<div class="flex items-center gap-2">
						<h3 id="indexes-{object.path.join('.')}" class="text-sm font-medium">
							Indexes <span class="text-muted-foreground">{description.indexes.length}</span>
						</h3>
						{#if can.createIndex}
							<Button size="xs" variant="outline" class="ml-auto" onclick={() => (indexDialog = true)}><PlusIcon />Create index</Button>
						{/if}
					</div>
					{#if description.indexes.length === 0}
						<p class="text-xs text-muted-foreground">No indexes.</p>
					{:else}
						<div class="overflow-hidden rounded-md border">
							<Table.Root class="text-xs">
								<Table.Header>
									<Table.Row>
										<Table.Head>Name</Table.Head>
										<Table.Head>Columns</Table.Head>
										<Table.Head>Unique</Table.Head>
										<Table.Head>Definition</Table.Head>
										{#if can.dropIndex}<Table.Head><span class="sr-only">Actions</span></Table.Head>{/if}
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each description.indexes as index (index.name)}
										<Table.Row>
											<Table.Cell class="font-mono font-medium">{index.name}</Table.Cell>
											<Table.Cell class="font-mono">{index.columns.join(', ')}</Table.Cell>
											<Table.Cell>{index.unique ? 'Yes' : 'No'}</Table.Cell>
											<Table.Cell class="max-w-md truncate font-mono text-muted-foreground" title={index.definition}
												>{index.definition ?? ''}</Table.Cell
											>
											{#if can.dropIndex}
												<Table.Cell class="w-px py-0">
													<Button
														size="icon-xs"
														variant="ghost"
														class="text-destructive"
														aria-label="Drop index {index.name}"
														title="Drop index"
														onclick={() => dropIndex(index.name)}><Trash2Icon /></Button
													>
												</Table.Cell>
											{/if}
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						</div>
					{/if}
				</section>

				<section aria-labelledby="fks-{object.path.join('.')}" class="space-y-2">
					<h3 id="fks-{object.path.join('.')}" class="text-sm font-medium">
						Foreign keys <span class="text-muted-foreground">{description.foreignKeys.length}</span>
					</h3>
					{#if description.foreignKeys.length === 0}
						<p class="text-xs text-muted-foreground">No foreign keys.</p>
					{:else}
						<div class="overflow-hidden rounded-md border">
							<Table.Root class="text-xs">
								<Table.Header>
									<Table.Row>
										<Table.Head>Name</Table.Head>
										<Table.Head>Columns</Table.Head>
										<Table.Head>References</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each description.foreignKeys as key (key.name)}
										<Table.Row>
											<Table.Cell class="font-mono font-medium">{key.name}</Table.Cell>
											<Table.Cell class="font-mono">{key.columns.join(', ')}</Table.Cell>
											<Table.Cell class="font-mono">
												{#if shell}
													<button
														type="button"
														class="text-primary underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
														onclick={() => void openReference(key.references.path)}
														title="Open {key.references.path.join('.')}"
														>{key.references.path.join('.')}</button
													>
												{:else}
													{key.references.path.join('.')}
												{/if}
												<span class="text-muted-foreground">({key.references.columns.join(', ')})</span>
											</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						</div>
					{/if}
				</section>

				{#if description.ddl}
					<section aria-labelledby="ddl-{object.path.join('.')}" class="space-y-2">
						<h3 id="ddl-{object.path.join('.')}" class="text-sm font-medium">DDL</h3>
						<CodeBlock code={description.ddl} label={info.capabilities.dialect ?? 'sql'} class="[&_pre]:max-h-96" />
					</section>
				{/if}
			</div>
		{/if}
	</Tabs.Content>
</Tabs.Root>

{#if description}
	<ColumnDialog bind:open={columnDialog} object={ref} dialect={info.capabilities.dialect} column={editingColumn} onsubmit={columnChanges} />
	<IndexDialog
		bind:open={indexDialog}
		object={ref}
		fields={description.columns.map((column) => column.name)}
		onsubmit={(change) => void alter('Create index', [change], 'Create index', 'Created the index.')}
	/>
{/if}
<ReviewDialog {review} />

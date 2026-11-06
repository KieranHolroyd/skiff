<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import FilePlusIcon from '@lucide/svelte/icons/file-plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import type {
		ApplyResult,
		Cell,
		Column,
		ObjectDescription,
		ObjectRef,
		RowChange
	} from '@skiff/studio/protocol';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import { StudioCallError, studioCall, studioStream } from '../client.js';
	import StudioEditor from '../editor/StudioEditor.svelte';
	import StudioGrid from '../grid/StudioGrid.svelte';
	import type { WorkspaceProps } from '../ui-types.js';
	import { studioErrorMessage, summarizeApply, type ApplySummary } from '../document/apply.js';
	import ConfirmDialog from '../document/ConfirmDialog.svelte';
	import { Confirmer } from '../document/confirm.svelte.js';
	import DocumentEditorDialog from '../document/DocumentEditorDialog.svelte';
	import {
		documentDelete,
		documentInsert,
		documentUpdate,
		formatDocument,
		idLabel,
		parseFilter,
		rowToDocument,
		truncatedFields,
		withFields,
		type MongoDocument
	} from '../document/ejson.js';
	import JsonDocumentList from '../document/JsonDocumentList.svelte';
	import {
		firstPage,
		nextPage,
		pageLabel,
		pageNumber,
		previousPage,
		type PagerState
	} from '../document/pager.js';
	import ResultNotice from '../document/ResultNotice.svelte';
	import SchemaPanel from '../document/SchemaPanel.svelte';

	/**
	 * MongoDB collection (or view) workspace, plan 22 Phase 2 UI track G.
	 *
	 * - `browse`: `query.native` is the EJSON filter, `sort` one field, `limit` the page size;
	 *   pages follow the opaque `page.next` cursor (keyset on `_id`, or skip for other sorts), with
	 *   a stack of earlier cursors for Previous.
	 * - `apply`: grid edits, the JSON editor (a top-level `$set` diff), insert and delete. Without a
	 *   replica set MongoDB can stop part-way, so a "Partially applied" result is shown as such.
	 * - `value`: full values of truncated fields.
	 */
	let { database, info, object, onquery }: WorkspaceProps = $props();

	const uid = $props.id();

	const ref = $derived<ObjectRef>({ path: object.path, kind: object.kind });
	const collection = $derived(object.path.at(-1) ?? object.name);
	const PAGE_SIZES = ['25', '50', '100', '250', '500'];

	// --- describe ------------------------------------------------------------------------------

	let description = $state.raw<ObjectDescription | null>(null);
	let describeError = $state<string | null>(null);

	async function describe(target: ObjectRef) {
		describeError = null;
		try {
			description = await studioCall(database, 'describe', { object: target });
		} catch (caught) {
			describeError = studioErrorMessage(caught);
		}
	}

	const editable = $derived(Boolean(description?.editable) && !info.readOnly);
	const readOnlyReason = $derived(
		info.readOnly ? 'The session is read-only.' : (description?.reason ?? null)
	);

	// --- query ---------------------------------------------------------------------------------

	interface AppliedQuery {
		native: string | undefined;
		sort: Array<{ column: string; dir: 'asc' | 'desc' }>;
		limit: number;
	}

	let filterText = $state('');
	let filterError = $state<{ message: string; position?: number } | null>(null);
	let sortField = $state('');
	let sortDir = $state<'asc' | 'desc'>('asc');
	let pageSize = $state('100');
	let applied = $state<AppliedQuery>({ native: undefined, sort: [], limit: 100 });
	let pager = $state<PagerState>(firstPage());

	const filterMarkers = $derived(
		filterError?.position !== undefined
			? [{ position: filterError.position, message: filterError.message }]
			: []
	);

	const fieldNames = $derived.by(() => {
		const names = new Set<string>();
		for (const column of description?.columns ?? []) names.add(column.name);
		for (const column of columns) names.add(column.name);
		return [...names];
	});

	function applyQuery() {
		const parsed = parseFilter(filterText);
		if (!parsed.ok) {
			filterError = {
				message: parsed.error,
				...(parsed.position === undefined ? {} : { position: parsed.position })
			};
			return;
		}
		filterError = null;
		applied = {
			native: parsed.native,
			sort: sortField ? [{ column: sortField, dir: sortDir }] : [],
			limit: Number(pageSize) || 100
		};
		pager = firstPage();
		estimate = undefined;
		void load();
	}

	function resetQuery() {
		filterText = '';
		sortField = '';
		sortDir = 'asc';
		applyQuery();
	}

	function queryThisCollection() {
		onquery?.(JSON.stringify({ find: collection, filter: {}, limit: 100 }));
	}

	// --- browse --------------------------------------------------------------------------------

	let columns = $state.raw<Column[]>([]);
	let rows = $state.raw<Cell[][]>([]);
	let next = $state<string | null>(null);
	let estimate = $state<number | undefined>(undefined);
	let loading = $state(false);
	let browseError = $state<string | null>(null);
	let notices = $state.raw<string[]>([]);
	let controller: AbortController | null = null;

	async function load() {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		loading = true;
		browseError = null;
		notices = [];
		let nextColumns: Column[] = [];
		let nextRows: Cell[][] = [];
		let nextCursor: string | null = null;
		try {
			for await (const event of studioStream(
				database,
				'browse',
				{
					object: ref,
					query: {
						limit: applied.limit,
						sort: applied.sort,
						...(applied.native ? { native: applied.native } : {}),
						...(pager.cursor ? { cursor: pager.cursor } : {})
					}
				},
				current.signal
			)) {
				if (event.t === 'columns') nextColumns = event.columns;
				else if (event.t === 'rows') nextRows = nextRows.concat(event.rows);
				else if (event.t === 'page') {
					nextCursor = event.next;
					if (event.estimate !== undefined) estimate = event.estimate;
				} else if (event.t === 'notice') notices = [...notices, event.message];
				else if (event.t === 'error') browseError = event.message;
			}
			columns = nextColumns;
			rows = nextRows;
			next = nextCursor;
			loadedDocs = {};
		} catch (caught) {
			if (!current.signal.aborted) browseError = studioErrorMessage(caught);
		} finally {
			if (controller === current) {
				loading = false;
				controller = null;
			}
		}
	}

	function goNext() {
		if (!next || loading) return;
		pager = nextPage(pager, next);
		void load();
	}

	function goPrevious() {
		if (pager.stack.length === 0 || loading) return;
		pager = previousPage(pager);
		void load();
	}

	// Without a filter, `describe` has the collection's estimated count for every page.
	const shownEstimate = $derived(
		applied.native ? undefined : (estimate ?? description?.estimate?.rows)
	);

	// A different object (or database) starts over.
	let loadedFor: string | null = null;
	$effect(() => {
		const id = JSON.stringify([database, object.kind, object.path]);
		if (id === loadedFor) return;
		loadedFor = id;
		const target: ObjectRef = { path: object.path, kind: object.kind };
		untrack(() => {
			description = null;
			columns = [];
			rows = [];
			next = null;
			estimate = undefined;
			filterText = '';
			filterError = null;
			sortField = '';
			sortDir = 'asc';
			applied = { native: undefined, sort: [], limit: Number(pageSize) || 100 };
			pager = firstPage();
			applySummary = null;
			applyError = null;
			void describe(target);
			void load();
		});
	});

	onDestroy(() => controller?.abort());

	// --- apply ---------------------------------------------------------------------------------

	const confirmer = new Confirmer();
	let applySummary = $state<ApplySummary | null>(null);
	let applyError = $state<string | null>(null);

	/** `fromGrid`: the grid toasts success itself, so only conflicts get a notice here. */
	async function applyChanges(changes: RowChange[], fromGrid = false): Promise<ApplyResult> {
		applySummary = null;
		applyError = null;
		try {
			const result = await studioCall(database, 'apply', { object: ref, changes });
			if (!fromGrid || result.conflicts.length > 0)
				applySummary = summarizeApply(result, changes.length);
			// Reload once the caller has seen the result (the grid maps conflicts onto its rows first).
			if (result.applied > 0) setTimeout(() => void load(), 0);
			return result;
		} catch (caught) {
			applyError = studioErrorMessage(caught);
			throw caught;
		}
	}

	async function confirmDeletes(count: number): Promise<boolean> {
		if (count === 0) return true;
		return confirmer.ask({
			title: count === 1 ? 'Delete this document?' : `Delete ${count} documents?`,
			description: `The ${count === 1 ? 'document is' : 'documents are'} removed from ${collection} for good. A document that changed since it was loaded is not deleted.`,
			confirmLabel: 'Delete',
			tone: 'danger'
		});
	}

	/** The grid's tray: confirm deletes, then apply. */
	async function gridApply(changes: RowChange[]): Promise<ApplyResult> {
		const deletes = changes.filter((change) => change.op === 'delete').length;
		if (!(await confirmDeletes(deletes)))
			throw new StudioCallError('cancelled', 'Nothing was applied: the delete was cancelled.', 499);
		return applyChanges(changes, true);
	}

	async function loadValue(row: Cell[], column: string): Promise<Cell> {
		const idIndex = columns.findIndex((c) => c.name === '_id');
		const result = await studioCall(database, 'value', {
			object: ref,
			key: { _id: row[idIndex] ?? null },
			column
		});
		return result.cell;
	}

	// --- JSON view -----------------------------------------------------------------------------

	let view = $state<'table' | 'json'>('table');
	/** Documents whose truncated fields were loaded in full, by row index. */
	let loadedDocs = $state.raw<Record<number, MongoDocument>>({});
	const documents = $derived(
		rows.map((row, index) => loadedDocs[index] ?? rowToDocument(columns, row))
	);
	let busyIndex = $state<number | null>(null);

	async function loadFull(index: number): Promise<MongoDocument | null> {
		const doc = documents[index];
		if (!doc) return null;
		const fields = truncatedFields(doc);
		if (fields.length === 0) return doc;
		busyIndex = index;
		try {
			const cells = await Promise.all(
				fields.map((column) =>
					studioCall(database, 'value', { object: ref, key: { _id: doc.id }, column }).then(
						(result) => [column, result.cell] as const
					)
				)
			);
			const loaded = withFields(doc, Object.fromEntries(cells));
			loadedDocs = { ...loadedDocs, [index]: loaded };
			return loaded;
		} catch (caught) {
			applyError = studioErrorMessage(caught);
			return null;
		} finally {
			busyIndex = null;
		}
	}

	let editing = $state.raw<MongoDocument | null>(null);
	let editorOpen = $state(false);
	let inserting = $state(false);

	async function edit(index: number) {
		const doc = await loadFull(index);
		if (!doc) return;
		if (truncatedFields(doc).length > 0) {
			applyError = 'Some fields are larger than the studio can load, so this document cannot be edited here.';
			return;
		}
		editing = doc;
		editorOpen = true;
	}

	async function applyFromEditor(change: RowChange): Promise<{ error: string } | null> {
		try {
			const result = await applyChanges([change]);
			if (result.conflicts.length === 0) return null;
			const summary = summarizeApply(result, 1);
			return { error: [summary.title, ...summary.details].join(' ') };
		} catch (caught) {
			return { error: studioErrorMessage(caught) };
		}
	}

	async function saveEdit(text: string) {
		if (!editing) return null;
		const edit = documentUpdate(editing, text);
		if (!edit.ok) return { error: edit.error, ...(edit.position === undefined ? {} : { position: edit.position }) };
		if (!edit.change) {
			applySummary = { tone: 'success', title: 'No changes to save.', details: [] };
			return null;
		}
		return applyFromEditor(edit.change);
	}

	async function saveInsert(text: string) {
		const insert = documentInsert(text);
		if (!insert.ok) return { error: insert.error, ...(insert.position === undefined ? {} : { position: insert.position }) };
		return insert.change ? applyFromEditor(insert.change) : null;
	}

	async function remove(index: number) {
		const doc = documents[index];
		if (!doc || !(await confirmDeletes(1))) return;
		busyIndex = index;
		try {
			await applyChanges([documentDelete(doc)]);
		} catch {
			// `applyChanges` already shows the error.
		} finally {
			busyIndex = null;
		}
	}

	let tab = $state('documents');
	const count = new Intl.NumberFormat('en-GB');
</script>

{#snippet pagerBar()}
	<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
		<span aria-live="polite">{pageLabel(pager, applied.limit, rows.length, shownEstimate)}</span>
		<span class="ml-auto">Page {pageNumber(pager)}</span>
		<Button
			variant="outline"
			size="xs"
			onclick={goPrevious}
			disabled={pager.stack.length === 0 || loading}
		>
			<ChevronLeftIcon />
			Previous
		</Button>
		<Button variant="outline" size="xs" onclick={goNext} disabled={!next || loading}>
			Next
			<ChevronRightIcon />
		</Button>
	</div>
{/snippet}

<div class="flex h-full min-h-0 flex-col gap-3 p-3">
	<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col">
		<div class="flex flex-wrap items-center gap-2">
			<Tabs.List>
				<Tabs.Trigger value="documents">Documents</Tabs.Trigger>
				<Tabs.Trigger value="indexes">
					Indexes
					{#if description}<Badge variant="secondary" class="tabular-nums"
							>{description.indexes.length}</Badge
						>{/if}
				</Tabs.Trigger>
				<Tabs.Trigger value="schema">Schema</Tabs.Trigger>
			</Tabs.List>
			<span class="font-mono text-sm">{collection}</span>
			{#if object.kind === 'view'}<Badge variant="info">view</Badge>{/if}
			{#if description?.estimate?.rows !== undefined}
				<span class="text-xs text-muted-foreground"
					>about {count.format(description.estimate.rows)} documents</span
				>
			{/if}
			<div class="ml-auto flex items-center gap-2">
				{#if readOnlyReason}
					<Badge variant="neutral" title={readOnlyReason}>Read-only</Badge>
				{/if}
				<Button variant="outline" size="sm" onclick={queryThisCollection} disabled={!onquery}>
					<SquareTerminalIcon />
					Query this collection
				</Button>
			</div>
		</div>

		{#if describeError}
			<Notice tone="danger" title="Could not describe {collection}">{describeError}</Notice>
		{/if}

		<Tabs.Content value="documents" class="flex min-h-0 flex-1 flex-col gap-3">
			<form
				class="flex flex-col gap-2"
				aria-label="Filter and sort"
				onsubmit={(event) => {
					event.preventDefault();
					applyQuery();
				}}
			>
				<div class="flex flex-col gap-1">
					<p id="doc-filter-{uid}" class="text-xs font-medium">
						Filter (Extended JSON, e.g. <code class="font-mono"
							>{'{"status": "active", "age": {"$gte": 18}}'}</code
						>) <span class="font-normal text-muted-foreground">· ⌘/Ctrl+Enter applies</span>
					</p>
					<div role="group" aria-labelledby="doc-filter-{uid}">
						<StudioEditor
							bind:value={filterText}
							language="mongo"
							markers={filterMarkers}
							onrun={applyQuery}
							class="h-16 w-full rounded-md border p-1.5"
						/>
					</div>
					{#if filterError}
						<p class="text-xs text-destructive" role="alert">{filterError.message}</p>
					{/if}
				</div>
				<div class="flex flex-wrap items-end gap-2">
					<div class="flex flex-col gap-1">
						<Label for="doc-sort-{uid}" class="text-xs">Sort by</Label>
						<NativeSelect.Root id="doc-sort-{uid}" size="sm" bind:value={sortField}>
							<NativeSelect.Option value="">_id (natural keyset order)</NativeSelect.Option>
							{#each fieldNames as name (name)}
								<NativeSelect.Option value={name}>{name}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</div>
					<div class="flex flex-col gap-1">
						<Label for="doc-dir-{uid}" class="text-xs">Direction</Label>
						<NativeSelect.Root id="doc-dir-{uid}" size="sm" bind:value={sortDir}>
							<NativeSelect.Option value="asc">Ascending</NativeSelect.Option>
							<NativeSelect.Option value="desc">Descending</NativeSelect.Option>
						</NativeSelect.Root>
					</div>
					<div class="flex flex-col gap-1">
						<Label for="doc-size-{uid}" class="text-xs">Page size</Label>
						<NativeSelect.Root id="doc-size-{uid}" size="sm" bind:value={pageSize}>
							{#each PAGE_SIZES as size (size)}
								<NativeSelect.Option value={size}>{size}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</div>
					<Button type="submit" size="sm" disabled={loading}>Apply</Button>
					<Button type="button" variant="outline" size="sm" onclick={resetQuery} disabled={loading}
						>Reset</Button
					>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onclick={() => void load()}
						disabled={loading}
						aria-label="Reload this page"
					>
						{#if loading}<Spinner />{:else}<RefreshCwIcon />{/if}
					</Button>
					<div class="ml-auto flex items-center gap-2">
						<ToggleGroup.Root
							type="single"
							variant="outline"
							size="sm"
							value={view}
							onValueChange={(value) => {
								if (value === 'table' || value === 'json') view = value;
							}}
							aria-label="Document view"
						>
							<ToggleGroup.Item value="table" class="px-3">Table</ToggleGroup.Item>
							<ToggleGroup.Item value="json" class="px-3">JSON</ToggleGroup.Item>
						</ToggleGroup.Root>
						{#if editable}
							<Button type="button" size="sm" variant="outline" onclick={() => (inserting = true)}>
								<FilePlusIcon />
								Insert document
							</Button>
						{/if}
					</div>
				</div>
			</form>

			{#if applied.sort.length > 0 && applied.sort[0]?.column !== '_id'}
				<p class="text-xs text-muted-foreground">
					Sorting by a field other than _id pages by offset, so documents inserted or deleted
					meanwhile can shift a page.
				</p>
			{/if}
			{#if browseError}
				<Notice tone="danger" title="Could not load documents">{browseError}</Notice>
			{/if}
			{#each notices as notice, index (index)}
				<Notice tone="info">{notice}</Notice>
			{/each}
			<ResultNotice
				summary={applySummary}
				error={applyError}
				ondismiss={() => {
					applySummary = null;
					applyError = null;
				}}
			/>

			<div class="flex min-h-0 flex-1 flex-col gap-2">
				{#if view === 'table'}
					<div class="min-h-0 flex-1">
						<StudioGrid
							{columns}
							{rows}
							label="Documents in {collection}"
							keyColumns={['_id']}
							{editable}
							onapply={gridApply}
							onloadvalue={loadValue}
							{loading}
							footer={pagerBar}
						/>
					</div>
				{:else}
					<div class="min-h-0 flex-1">
						<JsonDocumentList
							{documents}
							label="Documents in {collection}"
							{editable}
							busy={busyIndex}
							onedit={(index) => void edit(index)}
							ondelete={(index) => void remove(index)}
							onloadfull={(index) => void loadFull(index)}
						/>
					</div>
					{@render pagerBar()}
				{/if}
			</div>
		</Tabs.Content>

		<Tabs.Content value="indexes" class="min-h-0 flex-1 overflow-auto">
			{#if !description}
				<p class="p-2 text-sm text-muted-foreground">{describeError ? '' : 'Loading…'}</p>
			{:else if description.indexes.length === 0}
				<p class="p-2 text-sm text-muted-foreground">
					{object.kind === 'view' ? 'Views have no indexes of their own.' : 'No indexes.'}
				</p>
			{:else}
				<div class="overflow-auto rounded-md border">
					<table class="w-full text-sm">
						<caption class="sr-only">Indexes of {collection}</caption>
						<thead class="bg-muted text-left text-xs">
							<tr>
								<th scope="col" class="px-3 py-2 font-medium">Name</th>
								<th scope="col" class="px-3 py-2 font-medium">Keys</th>
								<th scope="col" class="px-3 py-2 font-medium">Unique</th>
								<th scope="col" class="px-3 py-2 font-medium">Definition</th>
							</tr>
						</thead>
						<tbody>
							{#each description.indexes as index (index.name)}
								<tr class="border-t align-top">
									<th scope="row" class="px-3 py-2 text-left font-mono text-xs font-normal"
										>{index.name}</th
									>
									<td class="px-3 py-2 font-mono text-xs">{index.columns.join(', ')}</td>
									<td class="px-3 py-2">
										{#if index.unique}<Badge variant="info">unique</Badge>{:else}<span
												class="text-muted-foreground">—</span
											>{/if}
									</td>
									<td class="px-3 py-2"
										><code class="font-mono text-xs break-all">{index.definition ?? ''}</code></td
									>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
			{#if description?.ddl}
				<h3 class="mt-4 mb-1 text-sm font-medium">
					{object.kind === 'view' ? 'View definition' : 'Collection options'}
				</h3>
				<pre class="overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-xs">{description.ddl}</pre>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="schema" class="min-h-0 flex-1 overflow-auto">
			{#if tab === 'schema'}
				<SchemaPanel {database} {collection} />
			{/if}
		</Tabs.Content>
	</Tabs.Root>
</div>

<DocumentEditorDialog
	bind:open={editorOpen}
	title={editing ? `Edit document ${idLabel(editing.id)}` : 'Edit document'}
	description="Changed and new top-level fields are saved with $set, each guarded by its loaded value."
	initial={editing ? formatDocument(editing) : '{}'}
	onsave={saveEdit}
>
	{#snippet notes()}
		Removing a field isn't supported here (it would need $unset): set it to null, or use "Query
		this collection". Fields that are null or missing aren't shown; add them to set them. Values
		use Extended JSON, e.g. <code class="font-mono">{'{"$date": "2026-01-01T00:00:00Z"}'}</code>.
	{/snippet}
</DocumentEditorDialog>

<DocumentEditorDialog
	bind:open={inserting}
	title="Insert a document into {collection}"
	description="Leave out _id and MongoDB assigns an ObjectId."
	initial={'{\n  \n}'}
	saveLabel="Insert"
	onsave={saveInsert}
>
	{#snippet notes()}
		Values use Extended JSON, e.g. <code class="font-mono">{'{"$oid": "…"}'}</code>,
		<code class="font-mono">{'{"$numberLong": "…"}'}</code>.
	{/snippet}
</DocumentEditorDialog>

<ConfirmDialog {confirmer} />

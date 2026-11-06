<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
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
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { StudioCallError, studioCall, studioStream } from '../client.js';
	import StudioGrid from '../grid/StudioGrid.svelte';
	import type { WorkspaceProps } from '../ui-types.js';
	import { studioErrorMessage, summarizeApply, type ApplySummary } from '../document/apply.js';
	import ConfirmDialog from '../document/ConfirmDialog.svelte';
	import { Confirmer } from '../document/confirm.svelte.js';
	import ResultNotice from '../document/ResultNotice.svelte';
	import AddKeyDialog from '../keyvalue/AddKeyDialog.svelte';
	import { KEY_TYPES, withoutColumns } from '../keyvalue/changes.js';
	import KeyDetail from '../keyvalue/KeyDetail.svelte';
	import {
		defaultPattern,
		EXPIRES_COLUMN,
		groupPrefix,
		keyName,
		keyRef,
		keyspaceRef,
		patternQuery,
		withExpiresColumn
	} from '../keyvalue/keys.js';

	/**
	 * Valkey/Redis workspace, plan 22 Phase 2 UI track G.
	 *
	 * - A keyspace or key group is a key list: `browse` with `query.native` as the SCAN MATCH
	 *   pattern and `query.type` as SCAN TYPE, appended page by page through the opaque cursor
	 *   ("Load more"; SCAN has no order and no sort). Rows are `key`, `type`, `ttl` (ms, null = no
	 *   expiry), `size`, `value` (strings only); the grid adds a human `expires` column.
	 *   Inline edits (string `value`, `ttl`), "Add key" and deletes go to `apply` on the same object.
	 *   "Open key" shows a key's detail in a side sheet.
	 * - A key is its detail view (`KeyDetail`).
	 * - "Open console" asks the shell for a query tab (`onquery('')`), which uses the redis language.
	 */
	let { database, info, object, onquery }: WorkspaceProps = $props();

	const uid = $props.id();
	const ref = $derived<ObjectRef>({ path: object.path, kind: object.kind });
	const db = $derived(object.path[0] ?? '0');
	const keyspace = $derived(keyspaceRef(object));
	const prefix = $derived(groupPrefix(object));
	const PAGE = 200;
	const confirmer = new Confirmer();

	// --- key list ------------------------------------------------------------------------------

	let description = $state.raw<ObjectDescription | null>(null);
	let pattern = $state('*');
	let typeFilter = $state('');
	let applied = $state<{ native: string | undefined; type: string | undefined }>({
		native: undefined,
		type: undefined
	});
	let columns = $state.raw<Column[]>([]);
	let rows = $state.raw<Cell[][]>([]);
	let next = $state<string | null>(null);
	let estimate = $state<number | undefined>(undefined);
	let loading = $state(false);
	let browseError = $state<string | null>(null);
	let notices = $state.raw<string[]>([]);
	let controller: AbortController | null = null;

	const editable = $derived(Boolean(description?.editable) && !info.readOnly);
	const shaped = $derived(withExpiresColumn(columns, rows));
	const keyIndex = $derived(columns.findIndex((column) => column.name === 'key'));
	const loadedKeys = $derived(
		keyIndex < 0 ? [] : rows.map((row) => row[keyIndex]).filter((key): key is string => typeof key === 'string')
	);

	async function describeList(target: ObjectRef) {
		try {
			description = await studioCall(database, 'describe', { object: target });
		} catch (caught) {
			browseError = studioErrorMessage(caught);
		}
	}

	async function load(append = false) {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		loading = true;
		browseError = null;
		if (!append) notices = [];
		const cursor = append ? next : null;
		let nextColumns: Column[] = append ? columns : [];
		let nextRows: Cell[][] = append ? rows : [];
		let nextCursor: string | null = null;
		try {
			for await (const event of studioStream(
				database,
				'browse',
				{
					object: ref,
					query: {
						limit: PAGE,
						...(applied.native ? { native: applied.native } : {}),
						...(applied.type ? { type: applied.type } : {}),
						...(cursor ? { cursor } : {})
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
		} catch (caught) {
			if (!current.signal.aborted) browseError = studioErrorMessage(caught);
		} finally {
			if (controller === current) {
				loading = false;
				controller = null;
			}
		}
	}

	function search() {
		applied = { native: patternQuery(pattern), type: typeFilter || undefined };
		void load();
	}

	function resetSearch() {
		pattern = defaultPattern(object);
		typeFilter = '';
		search();
	}

	let loadedFor: string | null = null;
	$effect(() => {
		const id = JSON.stringify([database, object.kind, object.path]);
		if (id === loadedFor) return;
		loadedFor = id;
		const target: ObjectRef = { path: object.path, kind: object.kind };
		const isKey = object.kind === 'key';
		const start = defaultPattern(object);
		untrack(() => {
			controller?.abort();
			description = null;
			columns = [];
			rows = [];
			next = null;
			estimate = undefined;
			applySummary = null;
			applyError = null;
			deleted = false;
			openKey = null;
			if (isKey) return;
			pattern = start;
			typeFilter = '';
			applied = { native: patternQuery(start), type: undefined };
			void describeList(target);
			void load();
		});
	});

	onDestroy(() => controller?.abort());

	// --- edits ---------------------------------------------------------------------------------

	let applySummary = $state<ApplySummary | null>(null);
	let applyError = $state<string | null>(null);
	let adding = $state(false);

	async function applyKeys(changes: RowChange[], fromGrid: boolean): Promise<ApplyResult> {
		applySummary = null;
		applyError = null;
		try {
			const result = await studioCall(database, 'apply', { object: ref, changes });
			if (!fromGrid || result.conflicts.length > 0) applySummary = summarizeApply(result, changes.length);
			// Edits are rare next to reading; reload from the first page so the list is current.
			if (result.applied > 0) setTimeout(() => void load(), 0);
			return result;
		} catch (caught) {
			applyError = studioErrorMessage(caught);
			throw caught;
		}
	}

	async function gridApply(changes: RowChange[]): Promise<ApplyResult> {
		const deletes = changes.filter((change) => change.op === 'delete');
		if (deletes.length > 0) {
			const names = deletes
				.map((change) => (change.op === 'delete' ? change.key.key : null))
				.filter((key): key is string => typeof key === 'string');
			const confirmed = await confirmer.ask({
				title: deletes.length === 1 ? `Delete ${names[0] ?? 'this key'}?` : `Delete ${deletes.length} keys?`,
				description: `${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''} ${deletes.length === 1 ? 'is' : 'are'} removed for good (UNLINK), whatever their type.`,
				confirmLabel: deletes.length === 1 ? 'Delete key' : 'Delete keys',
				tone: 'danger'
			});
			if (!confirmed) throw new StudioCallError('cancelled', 'Nothing was applied: the delete was cancelled.', 499);
		}
		return applyKeys(withoutColumns(changes, [EXPIRES_COLUMN]), true);
	}

	async function addKey(change: RowChange): Promise<string | null> {
		try {
			const result = await applyKeys([change], false);
			return result.conflicts.length > 0 ? result.conflicts.map((c) => c.reason).join(' ') : null;
		} catch (caught) {
			return studioErrorMessage(caught);
		}
	}

	async function loadValue(row: Cell[], column: string): Promise<Cell> {
		const key = row[shaped.columns.findIndex((c) => c.name === 'key')] ?? null;
		const result = await studioCall(database, 'value', { object: ref, key: { key }, column });
		return result.cell;
	}

	// --- key detail ----------------------------------------------------------------------------

	let openKey = $state<string | null>(null);
	let openKeyInput = $state('');
	let keyChanged = false;
	let deleted = $state(false);

	/** Clicking a key's row number opens its detail, like "Open key". */
	function openRow(row: Cell[]) {
		const name = row[shaped.columns.findIndex((column) => column.name === 'key')];
		if (typeof name === 'string') openKey = name;
	}

	function openDetail(event?: SubmitEvent) {
		event?.preventDefault();
		const name = openKeyInput.trim();
		if (!name) return;
		keyChanged = false;
		openKey = name;
	}

	function closeDetail(open: boolean) {
		if (open) return;
		openKey = null;
		if (keyChanged) void load();
	}

	const count = new Intl.NumberFormat('en-GB');
</script>

<div class="flex h-full min-h-0 flex-col gap-3 p-3">
	<div class="flex flex-wrap items-center gap-2">
		<KeyRoundIcon class="size-4 text-muted-foreground" />
		<span class="font-mono text-sm break-all">
			{object.kind === 'keyspace' ? `db${db}` : object.kind === 'key' ? keyName(object) : prefix + '*'}
		</span>
		{#if object.kind !== 'key' && (estimate ?? description?.estimate?.rows) !== undefined}
			<span class="text-xs text-muted-foreground"
				>{count.format((estimate ?? description?.estimate?.rows)!)} keys in the database</span
			>
		{/if}
		<div class="ml-auto flex items-center gap-2">
			{#if info.readOnly}<Badge variant="neutral">Read-only</Badge>{/if}
			<Button variant="outline" size="sm" onclick={() => onquery?.('')} disabled={!onquery}>
				<SquareTerminalIcon />
				Open console
			</Button>
		</div>
	</div>

	{#if object.kind === 'key'}
		{#if deleted}
			<Notice tone="success" title="Key deleted">
				{keyName(object)} was deleted. Close this tab or pick another key in the tree.
			</Notice>
		{:else}
			<div class="min-h-0 flex-1">
				<KeyDetail
					{database}
					{info}
					object={ref}
					{keyspace}
					name={keyName(object)}
					{confirmer}
					ondeleted={() => (deleted = true)}
				/>
			</div>
		{/if}
	{:else}
		<form
			class="flex flex-wrap items-end gap-2"
			aria-label="Find keys"
			onsubmit={(event) => {
				event.preventDefault();
				search();
			}}
		>
			<div class="flex min-w-56 flex-1 flex-col gap-1">
				<Label for="kv-pattern-{uid}" class="text-xs">MATCH pattern</Label>
				<Input
					id="kv-pattern-{uid}"
					bind:value={pattern}
					class="h-7 font-mono text-xs"
					autocomplete="off"
					spellcheck="false"
					aria-describedby="kv-pattern-help-{uid}"
				/>
			</div>
			<div class="flex flex-col gap-1">
				<Label for="kv-type-{uid}" class="text-xs">Type</Label>
				<NativeSelect.Root id="kv-type-{uid}" size="sm" bind:value={typeFilter}>
					<NativeSelect.Option value="">Any type</NativeSelect.Option>
					{#each KEY_TYPES as type (type)}
						<NativeSelect.Option value={type}>{type}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
			</div>
			<Button type="submit" size="sm" disabled={loading}>Search</Button>
			<Button type="button" size="sm" variant="outline" onclick={resetSearch} disabled={loading}>Reset</Button>
			<Button
				type="button"
				size="sm"
				variant="ghost"
				aria-label="Reload keys"
				onclick={() => void load()}
				disabled={loading}
			>
				{#if loading}<Spinner />{:else}<RefreshCwIcon />{/if}
			</Button>
			{#if editable}
				<Button type="button" size="sm" variant="outline" class="ml-auto" onclick={() => (adding = true)}>
					<PlusIcon />
					Add key
				</Button>
			{/if}
			<p id="kv-pattern-help-{uid}" class="w-full text-xs text-muted-foreground">
				<code class="font-mono">*</code> matches anything, <code class="font-mono">?</code> one
				character, <code class="font-mono">[abc]</code> one of a set; <code class="font-mono">\</code>
				escapes. SCAN returns keys in no particular order.
			</p>
		</form>

		<form class="flex flex-wrap items-end gap-2" aria-label="Open a key" onsubmit={openDetail}>
			<div class="flex min-w-56 flex-1 flex-col gap-1">
				<Label for="kv-open-{uid}" class="text-xs">Open key</Label>
				<Input
					id="kv-open-{uid}"
					bind:value={openKeyInput}
					list="kv-open-list-{uid}"
					placeholder="Type or pick a loaded key"
					class="h-7 font-mono text-xs"
					autocomplete="off"
					spellcheck="false"
				/>
				<datalist id="kv-open-list-{uid}">
					{#each loadedKeys.slice(0, 500) as key (key)}<option value={key}></option>{/each}
				</datalist>
			</div>
			<Button type="submit" size="sm" variant="outline" disabled={!openKeyInput.trim()}>Open</Button>
		</form>

		{#if browseError}<Notice tone="danger" title="Could not list keys">{browseError}</Notice>{/if}
		{#each notices as notice, index (index)}<Notice tone="info">{notice}</Notice>{/each}
		<ResultNotice
			summary={applySummary}
			error={applyError}
			ondismiss={() => {
				applySummary = null;
				applyError = null;
			}}
		/>
		{#if editable}
			<p class="text-xs text-muted-foreground">
				Edit a string's <span class="font-mono">value</span> or any key's
				<span class="font-mono">ttl</span> (milliseconds; empty for no expiry) in the grid. Other types
				are edited in the key's detail.
			</p>
		{/if}

		<div class="min-h-0 flex-1">
			<StudioGrid
				columns={shaped.columns}
				rows={shaped.rows}
				label="Keys matching {applied.native ?? '*'}"
				keyColumns={['key']}
				{editable}
				onapply={gridApply}
				onloadvalue={loadValue}
				onrowactivate={openRow}
				{loading}
			>
				{#snippet footer()}
					<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
						<span aria-live="polite">
							{count.format(rows.length)} key{rows.length === 1 ? '' : 's'} loaded{next
								? ''
								: ' · the scan is complete'}
						</span>
						{#if next}
							<Button variant="outline" size="xs" onclick={() => void load(true)} disabled={loading}>
								Load more
							</Button>
							{#if rows.length === 0 && !loading}
								<span>No matches in the part scanned so far; load more to keep scanning.</span>
							{/if}
						{/if}
					</div>
				{/snippet}
			</StudioGrid>
		</div>
	{/if}
</div>

<Sheet.Root open={openKey !== null} onOpenChange={closeDetail}>
	<Sheet.Content side="right" class="w-full gap-0 p-4 sm:max-w-2xl">
		<Sheet.Header class="p-0 pb-3">
			<Sheet.Title>Key detail</Sheet.Title>
			<Sheet.Description>Contents, TTL and edits for one key.</Sheet.Description>
		</Sheet.Header>
		{#if openKey !== null}
			<div class="min-h-0 flex-1">
				<KeyDetail
					{database}
					{info}
					object={keyRef(db, openKey)}
					{keyspace}
					name={openKey}
					{confirmer}
					onchanged={() => (keyChanged = true)}
					ondeleted={() => {
						keyChanged = true;
						closeDetail(false);
					}}
				/>
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>

<AddKeyDialog bind:open={adding} {prefix} onadd={addKey} />
<ConfirmDialog {confirmer} />

<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import BracesIcon from '@lucide/svelte/icons/braces';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import { toast } from 'svelte-sonner';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import type {
		ApplyResult,
		Cell,
		Column,
		ObjectDescription,
		ObjectRef,
		RowChange
	} from '@yoal/studio/protocol';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { StudioCallError, studioCall, studioStream } from '../client.js';
	import StudioGrid from '../grid/StudioGrid.svelte';
	import type { StudioInfo } from '@yoal/studio/protocol';
	import { studioErrorMessage, summarizeApply, type ApplySummary } from '../document/apply.js';
	import type { Confirmer } from '../document/confirm.svelte.js';
	import ResultNotice from '../document/ResultNotice.svelte';
	import AddRowForm from './AddRowForm.svelte';
	import { deleteKey, isKeyType, ROW_KEY, setKeyTtl } from './changes.js';
	import StringValueEditor from './StringValueEditor.svelte';
	import { canAlter } from '../structure/changes.js';
	import NameDialog from '../structure/NameDialog.svelte';
	import { AlterReview } from '../structure/review.svelte.js';
	import ReviewDialog from '../structure/ReviewDialog.svelte';
	import { formatBytes, formatTtl, parseTtl, ttlFromCell, ttlInput } from './ttl.js';

	/**
	 * One key: header (type, TTL editor, size, delete) and its contents.
	 *
	 * - Contents: `browse` of the `key` object (hash `field`/`value`, list `index`/`value`, set
	 *   `member`, zset `member`/`score`, stream `id`/`fields`, string `value`), paged with "Load
	 *   more", edited through `apply` on the same object with the plugin's in-key contract.
	 * - TTL and delete: `apply` on the keyspace object (`ttl` → PEXPIRE/PERSIST, delete → UNLINK),
	 *   whose `value` op also reads the key's current type and TTL.
	 */
	let {
		database,
		info,
		object,
		keyspace,
		name,
		confirmer,
		ondeleted,
		onchanged,
		onrenamed
	}: {
		database: string;
		info: StudioInfo;
		/** The `key` object. */
		object: ObjectRef;
		/** The keyspace object above it. */
		keyspace: ObjectRef;
		name: string;
		confirmer: Confirmer;
		ondeleted?: () => void;
		/** The key changed (value, TTL); a key list can refresh. */
		onchanged?: () => void;
		/** The key now has this name (RENAME); the caller reopens it under the new name. */
		onrenamed?: (name: string) => void;
	} = $props();

	const PAGE = 200;
	const uid = $props.id();

	// --- header --------------------------------------------------------------------------------

	let type = $state<string | null>(null);
	let ttlCell = $state<Cell>(null);
	let description = $state.raw<ObjectDescription | null>(null);
	let metaError = $state<string | null>(null);
	let gone = $state(false);
	let ttlText = $state('');
	let ttlError = $state<string | null>(null);
	let savingTtl = $state(false);
	let deleting = $state(false);

	const ttlMs = $derived(ttlFromCell(ttlCell));
	const editable = $derived(Boolean(description?.editable) && !info.readOnly);
	const canWrite = $derived(!info.readOnly && !gone);

	async function keyColumn(column: string): Promise<Cell> {
		const result = await studioCall(database, 'value', { object: keyspace, key: { key: name }, column });
		return result.cell;
	}

	async function loadMeta() {
		metaError = null;
		try {
			const [typeCell, ttl, described] = await Promise.all([
				keyColumn('type'),
				keyColumn('ttl'),
				studioCall(database, 'describe', { object })
			]);
			type = typeof typeCell === 'string' ? typeCell : null;
			ttlCell = ttl;
			ttlText = ttlInput(ttlFromCell(ttl));
			description = described;
			gone = false;
		} catch (caught) {
			if (caught instanceof StudioCallError && caught.code === 'not_found') gone = true;
			else metaError = studioErrorMessage(caught);
		}
	}

	async function saveTtl(clear: boolean) {
		const parsed = clear ? ({ ok: true, ms: null } as const) : parseTtl(ttlText);
		if (!parsed.ok) {
			ttlError = parsed.error;
			return;
		}
		savingTtl = true;
		ttlError = null;
		try {
			const result = await studioCall(database, 'apply', {
				object: keyspace,
				changes: [setKeyTtl(name, parsed.ms, ttlCell)]
			});
			if (result.conflicts.length > 0) ttlError = result.conflicts.map((c) => c.reason).join(' ');
			else {
				await loadMeta();
				onchanged?.();
			}
		} catch (caught) {
			ttlError = studioErrorMessage(caught);
		} finally {
			savingTtl = false;
		}
	}

	async function removeKey() {
		const confirmed = await confirmer.ask({
			title: `Delete ${name}?`,
			description: `The ${type ?? ''} key and everything in it are removed for good (UNLINK).`,
			confirmLabel: 'Delete key',
			tone: 'danger'
		});
		if (!confirmed) return;
		deleting = true;
		applyError = null;
		try {
			const result = await studioCall(database, 'apply', {
				object: keyspace,
				changes: [deleteKey(name, type ?? undefined)]
			});
			if (result.conflicts.length > 0) applySummary = summarizeApply(result, 1, () => name);
			else {
				gone = true;
				ondeleted?.();
			}
		} catch (caught) {
			applyError = studioErrorMessage(caught);
		} finally {
			deleting = false;
		}
	}

	// --- rename ---------------------------------------------------------------------------------

	const review = new AlterReview(() => database);
	const canRename = $derived(canWrite && canAlter(info, 'rename'));
	let renaming = $state(false);

	async function renameKey(next: string) {
		const done = await review.start({
			title: `Rename key ${name}`,
			description: 'The rename is refused if a key with the new name already exists. The TTL stays.',
			changes: [{ op: 'rename', object, name: next }],
			confirmLabel: 'Rename'
		});
		if (!done) return;
		toast.success(`Renamed ${name} to ${next}.`);
		onrenamed?.(next);
	}

	// --- contents ------------------------------------------------------------------------------

	let columns = $state.raw<Column[]>([]);
	let rows = $state.raw<Cell[][]>([]);
	let next = $state<string | null>(null);
	let loading = $state(false);
	let browseError = $state<string | null>(null);
	let notices = $state.raw<string[]>([]);
	let controller: AbortController | null = null;

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
				{ object, query: { limit: PAGE, ...(cursor ? { cursor } : {}) } },
				current.signal
			)) {
				if (event.t === 'columns') nextColumns = event.columns;
				else if (event.t === 'rows') nextRows = nextRows.concat(event.rows);
				else if (event.t === 'page') nextCursor = event.next;
				else if (event.t === 'notice') notices = [...notices, event.message];
				else if (event.t === 'error') browseError = event.message;
			}
			columns = nextColumns;
			rows = nextRows;
			next = nextCursor;
		} catch (caught) {
			if (current.signal.aborted) return;
			if (caught instanceof StudioCallError && caught.code === 'not_found') gone = true;
			else browseError = studioErrorMessage(caught);
		} finally {
			if (controller === current) {
				loading = false;
				controller = null;
			}
		}
	}

	function refresh() {
		void loadMeta();
		void load();
	}

	let loadedFor: string | null = null;
	$effect(() => {
		const id = JSON.stringify([database, object.path, name]);
		if (id === loadedFor) return;
		loadedFor = id;
		untrack(() => {
			type = null;
			description = null;
			columns = [];
			rows = [];
			next = null;
			gone = false;
			applySummary = null;
			applyError = null;
			refresh();
		});
	});

	onDestroy(() => controller?.abort());

	// --- in-key edits --------------------------------------------------------------------------

	let applySummary = $state<ApplySummary | null>(null);
	let applyError = $state<string | null>(null);

	async function applyInKey(changes: RowChange[], fromGrid: boolean): Promise<ApplyResult> {
		applySummary = null;
		applyError = null;
		try {
			const result = await studioCall(database, 'apply', { object, changes });
			if (!fromGrid || result.conflicts.length > 0) applySummary = summarizeApply(result, changes.length);
			if (result.applied > 0) {
				setTimeout(refresh, 0);
				onchanged?.();
			}
			return result;
		} catch (caught) {
			applyError = studioErrorMessage(caught);
			throw caught;
		}
	}

	async function gridApply(changes: RowChange[]): Promise<ApplyResult> {
		const deletes = changes.filter((change) => change.op === 'delete').length;
		if (deletes > 0) {
			const what = { hash: 'field', list: 'item', set: 'member', zset: 'member', stream: 'entry' }[type ?? ''] ?? 'row';
			const confirmed = await confirmer.ask({
				title: deletes === 1 ? `Delete this ${what}?` : `Delete ${deletes} ${what === 'entry' ? 'entries' : `${what}s`}?`,
				description: `They are removed from ${name} for good.`,
				confirmLabel: 'Delete',
				tone: 'danger'
			});
			if (!confirmed) throw new StudioCallError('cancelled', 'Nothing was applied: the delete was cancelled.', 499);
		}
		return applyInKey(changes, true);
	}

	async function addRow(change: RowChange): Promise<string | null> {
		try {
			const result = await applyInKey([change], false);
			return result.conflicts.length > 0 ? result.conflicts.map((c) => c.reason).join(' ') : null;
		} catch (caught) {
			return studioErrorMessage(caught);
		}
	}

	async function loadValue(row: Cell[], column: string): Promise<Cell> {
		const rowKey = type && isKeyType(type) ? ROW_KEY[type] : null;
		const index = rowKey ? columns.findIndex((c) => c.name === rowKey) : -1;
		const key = rowKey && index >= 0 ? { [rowKey]: row[index] ?? null } : {};
		const result = await studioCall(database, 'value', { object, key, column });
		return result.cell;
	}

	// --- full contents -------------------------------------------------------------------------

	let fullOpen = $state(false);
	let fullText = $state('');
	let fullLoading = $state(false);

	async function showFull() {
		fullOpen = true;
		fullLoading = true;
		fullText = '';
		try {
			const cell = await keyColumn('value');
			const value =
				cell && typeof cell === 'object' && !Array.isArray(cell) && '$t' in cell ? cell.v : cell;
			fullText =
				cell && typeof cell === 'object' && !Array.isArray(cell) && cell.$t === 'truncated'
					? `${String(value)}…\n\n(The contents are larger than this session's response limit.)`
					: JSON.stringify(value, null, 2);
		} catch (caught) {
			fullText = studioErrorMessage(caught);
		} finally {
			fullLoading = false;
		}
	}

	const count = new Intl.NumberFormat('en-GB');
	const lengthLabel = $derived.by(() => {
		const rowsTotal = description?.estimate?.rows;
		if (rowsTotal === undefined || type === 'string') return null;
		const unit = { hash: 'field', list: 'item', set: 'member', zset: 'member', stream: 'entry' }[type ?? ''] ?? 'row';
		return `${count.format(rowsTotal)} ${rowsTotal === 1 ? unit : unit === 'entry' ? 'entries' : `${unit}s`}`;
	});
	const addable = $derived(type === 'hash' || type === 'list' || type === 'set' || type === 'zset' ? type : null);
	const keyColumnNames = $derived(description?.primaryKey ?? []);
</script>

<div class="flex h-full min-h-0 flex-col gap-3">
	<header class="flex flex-col gap-2 border-b pb-3">
		<div class="flex flex-wrap items-center gap-2">
			<h2 class="min-w-0 font-mono text-sm font-medium break-all">{name}</h2>
			{#if type}<Badge variant="secondary" class="font-mono">{type}</Badge>{/if}
			{#if lengthLabel}<span class="text-xs text-muted-foreground">{lengthLabel}</span>{/if}
			{#if description?.estimate?.bytes !== undefined}
				<span class="text-xs text-muted-foreground" title="MEMORY USAGE"
					>{formatBytes(description.estimate.bytes)}</span
				>
			{/if}
			<div class="ml-auto flex items-center gap-1">
				<Button variant="ghost" size="icon-sm" aria-label="Reload key" onclick={refresh} disabled={loading}>
					{#if loading}<Spinner />{:else}<RefreshCwIcon />{/if}
				</Button>
				{#if canRename}
					<Button variant="outline" size="sm" onclick={() => (renaming = true)}>
						<PencilIcon />
						Rename
					</Button>
				{/if}
				{#if canWrite}
					<Button variant="outline" size="sm" class="text-destructive" onclick={removeKey} disabled={deleting}>
						{#if deleting}<Spinner />{:else}<Trash2Icon />{/if}
						Delete key
					</Button>
				{/if}
			</div>
		</div>
		{#if !gone && type}
			<form
				class="flex flex-wrap items-end gap-2"
				aria-label="Time to live"
				onsubmit={(event) => {
					event.preventDefault();
					void saveTtl(false);
				}}
			>
				<div class="flex flex-col gap-1">
					<Label for="kv-ttl-{uid}" class="text-xs">
						TTL <span class="font-normal text-muted-foreground">· {formatTtl(ttlMs)}</span>
					</Label>
					<Input
						id="kv-ttl-{uid}"
						bind:value={ttlText}
						placeholder="No expiry"
						class="h-7 w-40 text-xs"
						autocomplete="off"
						readonly={!canWrite}
						aria-describedby="kv-ttl-help-{uid}"
					/>
				</div>
				{#if canWrite}
					<Button type="submit" size="sm" variant="outline" disabled={savingTtl}>
						{#if savingTtl}<Spinner />{/if}
						Set TTL
					</Button>
					{#if ttlMs !== null}
						<Button type="button" size="sm" variant="ghost" onclick={() => void saveTtl(true)} disabled={savingTtl}>
							Remove expiry
						</Button>
					{/if}
				{/if}
				<p id="kv-ttl-help-{uid}" class="w-full text-xs text-muted-foreground">
					e.g. 30s, 5m, 1h 30m, 2d; a bare number is seconds.
				</p>
				{#if ttlError}<p class="w-full text-xs text-destructive" role="alert">{ttlError}</p>{/if}
			</form>
		{/if}
	</header>

	{#if gone}
		<Notice tone="info" title="This key no longer exists">
			It was deleted or expired. Reload the key list to see what is there now.
		</Notice>
	{:else}
		{#if metaError}<Notice tone="danger" title="Could not read the key">{metaError}</Notice>{/if}
		{#if browseError}<Notice tone="danger" title="Could not load the key's contents">{browseError}</Notice>{/if}
		{#each notices as notice, index (index)}<Notice tone="info">{notice}</Notice>{/each}
		<ResultNotice
			summary={applySummary}
			error={applyError}
			ondismiss={() => {
				applySummary = null;
				applyError = null;
			}}
		/>
		{#if description?.reason && !info.readOnly}
			<p class="text-xs text-muted-foreground">{description.reason}</p>
		{/if}

		{#if type === 'string'}
			{#if rows.length > 0}
				<StringValueEditor
					{database}
					{object}
					cell={rows[0]?.[0] ?? null}
					{editable}
					onsaved={() => {
						applySummary = { tone: 'success', title: 'Value saved.', details: [] };
						refresh();
						onchanged?.();
					}}
				/>
			{:else if loading}
				<p class="text-sm text-muted-foreground">Loading…</p>
			{/if}
		{:else if type}
			<div class="flex flex-wrap items-center gap-2">
				{#if editable && addable}
					<div class="min-w-0 flex-1"><AddRowForm type={addable} onadd={addRow} /></div>
				{/if}
				<Button variant="outline" size="sm" class="ml-auto" onclick={showFull}>
					<BracesIcon />
					Full contents as JSON
				</Button>
			</div>
			{#if type === 'stream'}
				<p class="text-xs text-muted-foreground">
					Stream entries can't be changed, only deleted (select rows in the grid). Add entries with
					XADD in the console.
				</p>
			{:else if type === 'list'}
				<p class="text-xs text-muted-foreground">
					Edit an item's value to LSET it by index; deletes use the index as loaded.
				</p>
			{/if}
			<div class="min-h-64 flex-1">
				<StudioGrid
					{columns}
					{rows}
					label="Contents of {name}"
					keyColumns={keyColumnNames}
					{editable}
					onapply={gridApply}
					onloadvalue={loadValue}
					{loading}
				>
					{#snippet footer()}
						<div class="flex items-center gap-2 text-xs text-muted-foreground">
							<span aria-live="polite">{count.format(rows.length)} loaded{next ? '' : ' (all)'}</span>
							{#if next}
								<Button variant="outline" size="xs" onclick={() => void load(true)} disabled={loading}>
									Load more
								</Button>
							{/if}
						</div>
					{/snippet}
				</StudioGrid>
			</div>
		{/if}
	{/if}
</div>

<Dialog.Root bind:open={fullOpen}>
	<Dialog.Content class="flex max-h-[85vh] flex-col sm:max-w-3xl">
		<Dialog.Header>
			<Dialog.Title>Contents of {name}</Dialog.Title>
			<Dialog.Description>Up to 10,000 items, read with one `value` call.</Dialog.Description>
		</Dialog.Header>
		{#if fullLoading}
			<p class="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading…</p>
		{:else}
			<pre class="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-xs">{fullText}</pre>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<NameDialog bind:open={renaming} title="Rename key {name}" label="New name" initial={name} onsubmit={(next) => void renameKey(next)} />
<ReviewDialog {review} />

<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import CircleSlashIcon from '@lucide/svelte/icons/circle-slash';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import Undo2Icon from '@lucide/svelte/icons/undo-2';
	import type { Cell, Column } from '@yoal/studio/protocol';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { describeStudioError } from '../shell/errors.js';
	import type { StudioGridProps } from '../ui-types.js';
	import CellEditor from './CellEditor.svelte';
	import CellInspector from './CellInspector.svelte';
	import {
		cellClipboardText,
		cellView,
		defaultWidth,
		isNumeric,
		isTruncated,
		truncatedSuffix
	} from './cells.js';
	import { editInitial, editorFor, parseEdit, type EditorKind } from './edit.js';
	import PendingTray from './PendingTray.svelte';
	import {
		addInsert,
		buildChanges,
		conflictsByTarget,
		editedValue,
		emptyPending,
		pendingCount,
		removeInsert,
		setCellEdit,
		setInsertValue,
		toggleDelete,
		type Pending
	} from './pending.js';

	/**
	 * The studio's data grid (plan 22): virtualised on both axes with a sticky header and row-number
	 * gutter, resizable columns, cells rendered by kind, a cell inspector, and (when `editable` and
	 * `keyColumns` allow) inline editing into a pending-changes tray applied through `onapply`.
	 *
	 * Beyond `StudioGridProps`, `sort`/`onsort` turn the headers into sort buttons (click sorts by
	 * one column, shift-click adds); the grid only shows the order, the caller fetches.
	 */
	let {
		columns,
		rows,
		label,
		keyColumns = [],
		editable = false,
		onapply,
		onloadvalue,
		loading = false,
		footer,
		sort = [],
		onsort,
		onrowactivate
	}: StudioGridProps = $props();

	const gridId = $props.id();
	const ROW_HEIGHT = 28;
	const HEADER_HEIGHT = 32;
	const GUTTER = 52;
	const MIN_WIDTH = 56;

	const canEdit = $derived(editable && keyColumns.length > 0 && onapply !== undefined);

	// --- state that belongs to one result -------------------------------------------------------

	let pending = $state<Pending>(emptyPending());
	/** Full values loaded for truncated cells, by `row:column`. */
	let loaded = $state<Record<string, Cell>>({});
	let loadingCell = $state<string | null>(null);
	let conflicts = $state<Record<string, string>>({});
	let partial = $state(0);
	let applying = $state(false);
	let applyError = $state<unknown>(null);
	let selected = $state<{ row: number; col: number } | null>(null);
	let editing = $state<{
		row: number;
		col: number;
		editor: Exclude<EditorKind, 'boolean'>;
		input: string;
		error: string | null;
	} | null>(null);
	let inspectorOpen = $state(false);
	let widths = $state<number[]>([]);

	const count = $derived(pendingCount(pending));
	const totalRows = $derived(rows.length + pending.inserts.length);

	// A new result (columns changed, or rows replaced rather than streamed in) starts clean.
	let previousRows: Cell[][] = [];
	let previousColumns = '';
	$effect(() => {
		const signature = columns.map((column) => `${column.name}:${column.kind}`).join('|');
		const next = rows;
		untrack(() => {
			const streamed = next.length >= previousRows.length && (previousRows.length === 0 || next[0] === previousRows[0]);
			const sameColumns = signature === previousColumns;
			if (!sameColumns) widths = columns.map(defaultWidth);
			if (!sameColumns || !streamed) {
				pending = emptyPending();
				loaded = {};
				conflicts = {};
				partial = 0;
				applyError = null;
				editing = null;
				if (selected && (selected.row >= next.length || selected.col >= columns.length)) selected = null;
			}
			previousRows = next;
			previousColumns = signature;
		});
	});

	// --- virtualisation --------------------------------------------------------------------------

	let viewport = $state<HTMLDivElement | null>(null);

	const rowVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => viewport,
		estimateSize: () => ROW_HEIGHT,
		// Item offsets include the sticky header and gutter, so `scrollToIndex` clears them.
		paddingStart: HEADER_HEIGHT,
		scrollPaddingStart: HEADER_HEIGHT,
		overscan: 12
	});
	const colVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		horizontal: true,
		count: 0,
		getScrollElement: () => viewport,
		estimateSize: (index) => widths[index] ?? 160,
		paddingStart: GUTTER,
		scrollPaddingStart: GUTTER,
		overscan: 3
	});

	// `setOptions` writes the store, so it must not be read reactively here or the effect loops.
	$effect(() => {
		const count = totalRows;
		const element = viewport;
		untrack(() => $rowVirtualizer.setOptions({ count, getScrollElement: () => element }));
	});
	$effect(() => {
		const count = columns.length;
		const sizes = [...widths];
		const element = viewport;
		untrack(() => {
			$colVirtualizer.setOptions({
				count,
				getScrollElement: () => element,
				estimateSize: (index) => sizes[index] ?? 160
			});
			$colVirtualizer.measure();
		});
	});

	const contentWidth = $derived(GUTTER + widths.reduce((sum, width) => sum + width, 0));

	// --- cells -------------------------------------------------------------------------------------

	const cellKey = (row: number, col: number) => `${row}:${col}`;
	const cellDomId = (row: number, col: number) => `${gridId}-r${row}-c${col}`;

	/** The loaded value (a full value replacing a truncated preview), before any pending edit. */
	function baseCell(row: number, col: number): Cell {
		const key = cellKey(row, col);
		return Object.hasOwn(loaded, key) ? loaded[key]! : (rows[row]?.[col] ?? null);
	}

	/** What the cell shows: the pending edit, else the loaded value; `undefined` = insert default. */
	function shownCell(row: number, col: number): Cell | undefined {
		const column = columns[col];
		if (!column) return null;
		if (row >= rows.length) {
			const values = pending.inserts[row - rows.length];
			return values && Object.hasOwn(values, column.name) ? values[column.name] : undefined;
		}
		return editedValue(pending, row, column.name) ?? baseCell(row, col);
	}

	function rowCells(row: number): Cell[] | null {
		if (row >= rows.length) return null;
		return columns.map((_, col) => baseCell(row, col));
	}

	function effectiveRows(): Cell[][] {
		return rows.map((cells, row) =>
			cells.some((_, col) => Object.hasOwn(loaded, cellKey(row, col)))
				? cells.map((_, col) => baseCell(row, col))
				: cells
		);
	}

	function isChanged(row: number, col: number): boolean {
		const column = columns[col];
		if (!column) return false;
		if (row >= rows.length) return Object.hasOwn(pending.inserts[row - rows.length] ?? {}, column.name);
		return editedValue(pending, row, column.name) !== undefined;
	}

	const isInsert = (row: number) => row >= rows.length;
	const isDeleted = (row: number) => row < rows.length && pending.deletes.includes(row);
	const rowConflict = (row: number) =>
		row >= rows.length
			? conflicts[`i:${row - rows.length}`]
			: (conflicts[`u:${row}`] ?? conflicts[`d:${row}`]);

	function cellEditPlan(row: number, col: number) {
		const column = columns[col];
		if (!canEdit || !column) return { ok: false as const, reason: 'Read-only.' };
		if (isDeleted(row)) return { ok: false as const, reason: 'This row is marked for deletion.' };
		return editorFor(column, row >= rows.length ? null : baseCell(row, col));
	}

	async function loadValue(row: number, col: number) {
		const column = columns[col];
		const cells = rowCells(row);
		if (!column || !cells || !onloadvalue) return;
		const key = cellKey(row, col);
		loadingCell = key;
		try {
			const cell = await onloadvalue(cells, column.name);
			loaded = { ...loaded, [key]: cell };
		} catch (caught) {
			const info = describeStudioError(caught);
			toast.error(`${info.title}: ${info.message}`);
		} finally {
			if (loadingCell === key) loadingCell = null;
		}
	}

	// --- selection and keyboard --------------------------------------------------------------------

	async function select(row: number, col: number, focusGrid = true) {
		if (totalRows === 0 || columns.length === 0) return;
		const next = {
			row: Math.max(0, Math.min(totalRows - 1, row)),
			col: Math.max(0, Math.min(columns.length - 1, col))
		};
		selected = next;
		// Let the virtualisers pick up a changed row count (an added row) before scrolling.
		await tick();
		$rowVirtualizer.scrollToIndex(next.row, { align: 'auto' });
		$colVirtualizer.scrollToIndex(next.col, { align: 'auto' });
		if (focusGrid) viewport?.focus({ preventScroll: true });
	}

	function pageRows(): number {
		return Math.max(1, Math.floor(((viewport?.clientHeight ?? 300) - HEADER_HEIGHT) / ROW_HEIGHT) - 1);
	}

	function gridKeydown(event: KeyboardEvent) {
		if (editing) return;
		const mod = event.metaKey || event.ctrlKey;
		if (mod && event.key.toLowerCase() === 'c') {
			if (!selected || window.getSelection()?.toString()) return;
			event.preventDefault();
			void copyCell();
			return;
		}
		if (!selected) {
			if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
				event.preventDefault();
				void select(0, 0);
			}
			return;
		}
		const { row, col } = selected;
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				void select(mod ? totalRows - 1 : row + 1, col);
				break;
			case 'ArrowUp':
				event.preventDefault();
				void select(mod ? 0 : row - 1, col);
				break;
			case 'ArrowRight':
				event.preventDefault();
				void select(row, mod ? columns.length - 1 : col + 1);
				break;
			case 'ArrowLeft':
				event.preventDefault();
				void select(row, mod ? 0 : col - 1);
				break;
			case 'Home':
				event.preventDefault();
				void select(mod ? 0 : row, 0);
				break;
			case 'End':
				event.preventDefault();
				void select(mod ? totalRows - 1 : row, columns.length - 1);
				break;
			case 'PageDown':
				event.preventDefault();
				void select(row + pageRows(), col);
				break;
			case 'PageUp':
				event.preventDefault();
				void select(row - pageRows(), col);
				break;
			case 'Enter':
			case 'F2':
				event.preventDefault();
				if (canEdit) startEdit(row, col);
				else inspectorOpen = true;
				break;
			case ' ':
				event.preventDefault();
				inspectorOpen = true;
				break;
			case 'Escape':
				selected = null;
				break;
		}
	}

	async function copyCell() {
		if (!selected) return;
		const cell = shownCell(selected.row, selected.col);
		try {
			await navigator.clipboard.writeText(cell === undefined ? '' : cellClipboardText(cell));
			toast.success('Copied the cell.', { duration: 1200 });
		} catch {
			toast.error('Could not copy to the clipboard.');
		}
	}

	// --- editing -------------------------------------------------------------------------------------

	function startEdit(row: number, col: number) {
		const column = columns[col];
		if (!column) return;
		const plan = cellEditPlan(row, col);
		if (!plan.ok) {
			if (isTruncated(baseCell(row, col)) && onloadvalue) {
				toast.info('Loading the full value first…', { duration: 1500 });
				void loadValue(row, col);
			} else toast.info(plan.reason, { duration: 2500 });
			return;
		}
		const current = shownCell(row, col) ?? null;
		if (plan.editor === 'boolean') {
			commitValue(row, col, current === true ? false : true);
			return;
		}
		selected = { row, col };
		editing = {
			row,
			col,
			editor: plan.editor,
			input: String(editInitial(column, current, plan.editor)),
			error: null
		};
	}

	function commitValue(row: number, col: number, value: Cell) {
		const column = columns[col];
		if (!column) return;
		if (row >= rows.length) pending = setInsertValue(pending, row - rows.length, column.name, value);
		else pending = setCellEdit(pending, row, column.name, value, baseCell(row, col));
		applyError = null;
	}

	/** Commit the open editor. False when its input doesn't parse (the editor stays open). */
	function commitEdit(move?: 'next' | 'previous'): boolean {
		if (!editing) return true;
		const { row, col, input } = editing;
		const column = columns[col];
		if (!column) {
			editing = null;
			return true;
		}
		const original = row >= rows.length ? null : baseCell(row, col);
		const parsed = parseEdit(column, original, input);
		if (!parsed.ok) {
			editing = { ...editing, error: parsed.error };
			return false;
		}
		commitValue(row, col, parsed.value);
		editing = null;
		void select(row, move === 'next' ? col + 1 : move === 'previous' ? col - 1 : col);
		return true;
	}

	function cancelEdit() {
		const at = editing;
		editing = null;
		if (at) void select(at.row, at.col);
	}

	function setNull() {
		if (!selected) return;
		const column = columns[selected.col];
		if (!column || !cellEditPlan(selected.row, selected.col).ok) return;
		if (column.nullable === false) {
			toast.info(`${column.name} can't be NULL.`);
			return;
		}
		commitValue(selected.row, selected.col, null);
	}

	function addRow() {
		pending = addInsert(pending);
		void select(rows.length + pending.inserts.length - 1, 0);
	}

	function deleteRow() {
		if (!selected) return;
		if (selected.row >= rows.length) {
			pending = removeInsert(pending, selected.row - rows.length);
			if (totalRows - 1 === 0) selected = null;
			else void select(Math.min(selected.row, totalRows - 2), selected.col);
		} else pending = toggleDelete(pending, selected.row);
	}

	function discard() {
		pending = emptyPending();
		conflicts = {};
		partial = 0;
		applyError = null;
		editing = null;
		if (selected && selected.row >= rows.length) selected = null;
	}

	const build = () => buildChanges({ columns, rows: effectiveRows(), keyColumns, pending });

	async function apply() {
		if (!onapply || applying) return;
		if (editing && !commitEdit()) return;
		const built = build();
		if (built.problems.length > 0) {
			toast.error(built.problems[0]!);
			return;
		}
		if (built.changes.length === 0) {
			discard();
			return;
		}
		applying = true;
		applyError = null;
		try {
			const result = await onapply(built.changes);
			if (result.conflicts.length > 0) {
				conflicts = conflictsByTarget(result, built.targets);
				partial = result.applied;
			} else {
				toast.success(`Applied ${result.applied} ${result.applied === 1 ? 'change' : 'changes'}.`);
				discard();
				loaded = {};
			}
		} catch (caught) {
			applyError = caught;
		} finally {
			applying = false;
		}
	}

	// --- column resize -------------------------------------------------------------------------------

	let resizing: { col: number; x: number; width: number } | null = null;
	function resizeStart(event: PointerEvent, col: number) {
		event.preventDefault();
		event.stopPropagation();
		resizing = { col, x: event.clientX, width: widths[col] ?? 160 };
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}
	function resizeMove(event: PointerEvent) {
		if (!resizing) return;
		const next = [...widths];
		next[resizing.col] = Math.max(MIN_WIDTH, Math.round(resizing.width + event.clientX - resizing.x));
		widths = next;
	}
	function resizeEnd() {
		resizing = null;
	}
	function resetWidth(col: number) {
		const column = columns[col];
		if (!column) return;
		const next = [...widths];
		next[col] = defaultWidth(column);
		widths = next;
	}

	const sortIndex = (name: string) => sort.findIndex((entry) => entry.column === name);

	// --- inspector -----------------------------------------------------------------------------------

	const inspected = $derived(selected ? { column: columns[selected.col] ?? null, row: selected.row, col: selected.col } : null);

	const selectedPlan = $derived(selected ? cellEditPlan(selected.row, selected.col) : null);
</script>

<div class="flex h-full min-h-0 flex-col gap-2">
	{#if columns.length > 0}
		<div class="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="{label} actions">
			{#if canEdit}
				<Button size="xs" variant="outline" onclick={addRow}><PlusIcon />Add row</Button>
				<Button size="xs" variant="outline" disabled={!selected} onclick={deleteRow}>
					{#if selected && isDeleted(selected.row)}<Undo2Icon />Restore row{:else}<TrashIcon />Delete row{/if}
				</Button>
				<Button
					size="xs"
					variant="ghost"
					disabled={!selectedPlan?.ok || inspected?.column?.nullable === false}
					onclick={setNull}><CircleSlashIcon />Set NULL</Button
				>
			{/if}
			<Button size="xs" variant="ghost" disabled={!selected} onclick={() => (inspectorOpen = true)}>
				<Maximize2Icon />Inspect
			</Button>
			<span class="ml-auto hidden text-[0.6875rem] text-muted-foreground lg:inline">
				{#if canEdit}<Kbd>Enter</Kbd> edit ·{/if}
				<Kbd>Space</Kbd> inspect · <Kbd>⌘C</Kbd> copy
			</span>
		</div>
	{/if}

	<div
		bind:this={viewport}
		id={gridId}
		role="grid"
		aria-label={label}
		aria-rowcount={totalRows + 1}
		aria-colcount={columns.length + 1}
		aria-readonly={!canEdit}
		aria-busy={loading || undefined}
		aria-activedescendant={selected && !editing ? cellDomId(selected.row, selected.col) : undefined}
		tabindex="0"
		class="relative min-h-0 flex-1 overflow-auto rounded-md border bg-card text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
		onkeydown={gridKeydown}
	>
		<div
			class="relative"
			style="width: {contentWidth}px; min-width: 100%; height: {$rowVirtualizer.getTotalSize()}px"
		>
			<!-- Header ------------------------------------------------------------------------------ -->
			<div
				role="row"
				aria-rowindex={1}
				class="sticky top-0 z-20 border-b bg-muted"
				style="height: {HEADER_HEIGHT}px; width: {contentWidth}px; min-width: 100%"
			>
				<div
					role="columnheader"
					aria-colindex={1}
					class="sticky left-0 z-10 flex h-full items-center justify-end border-r bg-muted px-2 text-muted-foreground"
					style="width: {GUTTER}px"
				>
					<span aria-hidden="true">#</span><span class="sr-only">Row</span>
				</div>
				{#each $colVirtualizer.getVirtualItems() as item (item.key)}
					{@const column = columns[item.index]!}
					{@const at = sortIndex(column.name)}
					{@const entry = at >= 0 ? sort[at] : undefined}
					<div
						role="columnheader"
						aria-colindex={item.index + 2}
						aria-sort={at === 0 && entry ? (entry.dir === 'asc' ? 'ascending' : 'descending') : undefined}
						class="group absolute top-0 flex h-full items-center border-r"
						style="left: {item.start}px; width: {item.size}px"
						title="{column.name} · {column.nativeType}{column.nullable === false ? ' · not null' : ''}"
					>
						{#if onsort}
							<button
								type="button"
								class="flex h-full min-w-0 flex-1 items-center gap-1 px-2 text-left outline-none hover:bg-background/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
								onclick={(event) => onsort(column.name, event.shiftKey)}
								aria-label="Sort by {column.name}{entry ? `, now ${entry.dir === 'asc' ? 'ascending' : 'descending'}` : ''}. Shift-click to add."
							>
								{@render headerLabel(column)}
								{#if entry}
									<span class="ml-auto flex shrink-0 items-center text-foreground">
										{#if entry.dir === 'asc'}<ArrowUpIcon class="size-3" />{:else}<ArrowDownIcon class="size-3" />{/if}
										{#if sort.length > 1}<span class="text-[0.625rem]">{at + 1}</span>{/if}
									</span>
								{/if}
							</button>
						{:else}
							<div class="flex min-w-0 flex-1 items-center gap-1 px-2">{@render headerLabel(column)}</div>
						{/if}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize touch-none hover:bg-ring/40"
							aria-hidden="true"
							onpointerdown={(event) => resizeStart(event, item.index)}
							onpointermove={resizeMove}
							onpointerup={resizeEnd}
							onpointercancel={resizeEnd}
							ondblclick={() => resetWidth(item.index)}
						></div>
					</div>
				{/each}
			</div>

			<!-- Body: rows sit absolutely below the header (their offsets include it) ------------ -->
				{#each $rowVirtualizer.getVirtualItems() as rowItem (rowItem.key)}
					{@const row = rowItem.index}
					{@const deleted = isDeleted(row)}
					{@const inserted = isInsert(row)}
					{@const conflict = rowConflict(row)}
					<div
						role="row"
						aria-rowindex={row + 2}
						class="absolute top-0 left-0 border-b border-border/60 {deleted
							? 'bg-destructive/10 text-muted-foreground line-through'
							: inserted
								? 'bg-success/10'
								: 'hover:bg-muted/40'}"
						style="height: {ROW_HEIGHT}px; width: {contentWidth}px; min-width: 100%; transform: translateY({rowItem.start}px)"
					>
						<div
							role="rowheader"
							aria-colindex={1}
							class="sticky left-0 z-10 flex h-full items-center justify-end gap-1 border-r px-2 text-muted-foreground tabular-nums no-underline {conflict
								? 'bg-destructive/15 text-destructive'
								: 'bg-card'}"
							style="width: {GUTTER}px"
							title={conflict ? `Conflict: ${conflict}` : undefined}
						>
							{#if conflict}<span class="sr-only">Conflict: {conflict}.</span>{/if}
							{#if inserted}<span aria-label="New row">+</span>{:else if onrowactivate}<button
									type="button"
									class="rounded px-1 text-primary underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
									aria-label="Open row {row + 1}"
									onclick={() => onrowactivate(rows[row]!, row)}>{row + 1}</button
								>{:else}{row + 1}{/if}
						</div>
						{#each $colVirtualizer.getVirtualItems() as colItem (colItem.key)}
							{@const col = colItem.index}
							{@const column = columns[col]!}
							{@const cell = shownCell(row, col)}
							{@const isSelected = selected?.row === row && selected?.col === col}
							{@const isEditing = editing?.row === row && editing?.col === col}
							{@const changed = isChanged(row, col)}
							<!-- Keyboard is handled on the grid (aria-activedescendant), not per cell. -->
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<div
								id={cellDomId(row, col)}
								role="gridcell"
								tabindex={-1}
								aria-colindex={col + 2}
								aria-selected={isSelected}
								class="absolute top-0 flex h-full items-center border-r border-border/60 px-2 {isEditing
									? 'overflow-visible'
									: 'overflow-hidden'} {isNumeric(column) ? 'justify-end tabular-nums' : ''} {changed
									? 'bg-warning/15'
									: ''} {isSelected ? 'z-[5] outline-2 -outline-offset-2 outline-ring' : ''}"
								style="left: {colItem.start}px; width: {colItem.size}px"
								onclick={() => {
									if (isEditing) return;
									if (editing && !commitEdit()) return;
									void select(row, col);
								}}
								ondblclick={() => {
									if (canEdit) startEdit(row, col);
									else inspectorOpen = true;
								}}
							>
								{#if isEditing && editing}
									<CellEditor
										{column}
										editor={editing.editor}
										bind:value={editing.input}
										error={editing.error}
										oncommit={(move) => commitEdit(move)}
										oncancel={cancelEdit}
									/>
								{:else}
									{@render content(cell, row, col)}
								{/if}
							</div>
						{/each}
					</div>
				{/each}
		</div>

		{#if totalRows === 0 && !loading}
			<p class="sticky left-0 p-4 text-muted-foreground">No rows.</p>
		{/if}
	</div>

	{#if count > 0 || Object.keys(conflicts).length > 0}
		<PendingTray
			{count}
			built={build}
			{conflicts}
			{applying}
			{applyError}
			{partial}
			onapply={() => void apply()}
			ondiscard={discard}
		/>
	{/if}

	{@render footer?.()}
</div>

{#snippet headerLabel(column: Column)}
	{#if keyColumns.includes(column.name)}
		<KeyRoundIcon class="size-3 shrink-0 text-warning" aria-label="Key" />
	{/if}
	<span class="truncate font-medium">{column.name}</span>
	<span class="truncate font-mono text-[0.625rem] font-normal text-muted-foreground">{column.nativeType}</span>
{/snippet}

{#snippet content(cell: Cell | undefined, row: number, col: number)}
	{#if cell === undefined}
		<span class="text-muted-foreground italic">DEFAULT</span>
	{:else}
		{@const view = cellView(cell)}
		{#if view.kind === 'null'}
			<span class="rounded-sm bg-muted px-1 font-mono text-[0.625rem] text-muted-foreground uppercase">null</span>
		{:else if view.kind === 'plain'}
			<span class="truncate {typeof cell === 'number' ? 'font-mono' : ''}" title={view.text.length > 40 ? view.text.slice(0, 500) : undefined}>{view.text}</span>
		{:else if view.kind === 'tagged'}
			<span class="truncate font-mono" title={view.text.length > 40 ? view.text.slice(0, 500) : undefined}>{view.text}</span>
			<span class="ml-1 shrink-0 font-mono text-[0.5625rem] text-muted-foreground/70" aria-label="type {view.tag}">{view.tag}</span>
		{:else}
			<span class="truncate font-mono">{view.text}</span>
			{#if onloadvalue && row < rows.length}
				<button
					type="button"
					class="ml-1 shrink-0 rounded px-1 text-[0.625rem] text-info hover:bg-info/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					title="Load the full value"
					onclick={(event) => {
						event.stopPropagation();
						void loadValue(row, col);
					}}
				>
					{#if loadingCell === cellKey(row, col)}<Spinner class="size-3" />{:else}{truncatedSuffix(view.bytes)}{/if}
				</button>
			{:else}
				<span class="ml-1 shrink-0 text-[0.625rem] text-muted-foreground">{truncatedSuffix(view.bytes)}</span>
			{/if}
		{/if}
	{/if}
{/snippet}

<CellInspector
	bind:open={inspectorOpen}
	{columns}
	column={inspected?.column ?? null}
	cell={inspected ? shownCell(inspected.row, inspected.col) : undefined}
	row={inspected ? (inspected.row < rows.length ? columns.map((_, col) => shownCell(inspected.row, col) ?? null) : null) : null}
	rowLabel={inspected ? (inspected.row < rows.length ? `row ${inspected.row + 1}` : 'new row') : ''}
	loading={inspected ? loadingCell === cellKey(inspected.row, inspected.col) : false}
	onload={inspected && onloadvalue && inspected.row < rows.length ? () => void loadValue(inspected.row, inspected.col) : undefined}
/>

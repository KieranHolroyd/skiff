<script lang="ts">
	import { browser } from '$app/env';
	import { untrack } from 'svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import { toast } from 'svelte-sonner';
	import type { DatabaseStudioPrincipalState } from '@yoal/contracts';
	import type { SchemaChangeInput, StudioInfo, TreeNode } from '@yoal/studio/protocol';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { studioCall } from '../client.js';
	import QueryTab from '../query/QueryTab.svelte';
	import DocumentWorkspace from '../workspaces/DocumentWorkspace.svelte';
	import KeyValueWorkspace from '../workspaces/KeyValueWorkspace.svelte';
	import RelationalWorkspace from '../workspaces/RelationalWorkspace.svelte';
	import { canAlter } from '../structure/changes.js';
	import CreateTableDialog from '../structure/CreateTableDialog.svelte';
	import NameDialog from '../structure/NameDialog.svelte';
	import { AlterReview } from '../structure/review.svelte.js';
	import ReviewDialog from '../structure/ReviewDialog.svelte';
	import { closeSession, confirmEnableWrites, openReadOnly } from './actions.js';
	import { setStudioShell, type StructureEvent } from './context.js';
	import ObjectTree from './ObjectTree.svelte';
	import PreparingAccess from './PreparingAccess.svelte';
	import StudioErrorNotice from './StudioErrorNotice.svelte';
	import StudioHeader from './StudioHeader.svelte';
	import TabStrip from './TabStrip.svelte';
	import {
		closeObjectTabs,
		closeTab,
		emptyTabs,
		focusTab,
		loadTabs,
		openObjectTab,
		openQueryTab,
		renameObjectTab,
		saveTabs,
		tabDomId,
		tabPanelDomId,
		type TabsState
	} from './tabs.js';
	import { StudioTree } from './tree.svelte.js';
	import { pathKey } from './tree.js';

	/**
	 * The studio workspace for one open session (plan 22): session bar, object tree on the left,
	 * object and query tabs on the right. The route keys it by session, so a new session (or a
	 * mode switch) starts from a fresh tree and fresh workspaces while the open tabs carry over.
	 */
	let {
		database,
		engine,
		nodeLabel,
		sessionId,
		readOnly,
		expiresAt,
		canWrite,
		principal = 'ready',
		principalError = null
	}: {
		database: string;
		engine: string;
		/** Node name for the "Connecting…" line. */
		nodeLabel: string;
		sessionId: string;
		readOnly: boolean;
		expiresAt: string | null;
		canWrite: boolean;
		/** A read-only session waits for the database's read-only account (track G). */
		principal?: DatabaseStudioPrincipalState;
		principalError?: string | null;
	} = $props();

	// Fixed for this component's life: the route remounts it per session.
	const name = untrack(() => database);

	const info = createQuery(() => ({
		queryKey: ['studio-info', name, sessionId, readOnly],
		queryFn: ({ signal }) => studioCall(name, 'info', {}, signal),
		// Nothing to connect to until the read-only principal is ready.
		enabled: browser && principal === 'ready',
		staleTime: Infinity,
		retry: false
	}));

	const tree = new StudioTree(name);
	$effect(() => {
		if (info.isSuccess && tree.roots === null && !tree.loading && !tree.error)
			untrack(() => void tree.load());
	});

	// --- tabs ----------------------------------------------------------------------------------

	const storage = (): Storage | undefined => {
		try {
			return browser ? window.sessionStorage : undefined;
		} catch {
			return undefined;
		}
	};

	let tabs = $state<TabsState>(browser ? loadTabs(storage(), name) : emptyTabs());
	$effect(() => {
		const snapshot = $state.snapshot(tabs) as TabsState;
		saveTabs(storage(), name, snapshot);
	});

	const activeTab = $derived(tabs.tabs.find((tab) => tab.id === tabs.active) ?? null);
	const activePath = $derived(activeTab?.type === 'object' ? pathKey(activeTab.node.path) : null);

	function openObject(node: TreeNode) {
		tabs = openObjectTab(tabs, node);
	}

	function newQuery(input = '') {
		tabs = openQueryTab(tabs, input);
	}

	// --- structure edits -------------------------------------------------------------------------

	async function structureChanged(event: StructureEvent) {
		if (event.kind === 'renamed') tabs = renameObjectTab(tabs, event.from, event.to);
		else if (event.kind === 'dropped') tabs = closeObjectTabs(tabs, event.path);
		await tree.refresh();
		if (event.kind === 'created') {
			const node = await tree.reveal(event.path);
			if (node?.browsable) openObject(node);
		}
	}

	setStudioShell({
		async openPath(path) {
			const node = await tree.reveal(path);
			if (!node?.browsable) return false;
			openObject(node);
			return true;
		},
		reopen: openReadOnly,
		structureChanged: (event) => void structureChanged(event)
	});

	const review = new AlterReview(() => name);
	let creatingTable = $state(false);
	let creatingSchema = $state(false);
	let creatingCollection = $state(false);

	/** Schemas loaded at the tree root, for the new table's schema choice. */
	const schemaNames = $derived(
		(tree.roots ?? []).filter((item) => item.node.kind === 'schema').map((item) => item.node.name)
	);
	/** Start a new table in the schema of the object in front, when there is one. */
	const activeSchema = $derived(
		activeTab?.type === 'object' && activeTab.node.path.length > 1 ? (activeTab.node.path[0] ?? null) : null
	);

	async function create(change: SchemaChangeInput, what: string, path: string[], nodeKind: TreeNode['kind']) {
		const done = await review.start({ title: `Create ${what}`, changes: [change], confirmLabel: 'Create' });
		if (!done) return;
		toast.success(`Created ${path.join('.')}.`);
		void structureChanged({ kind: 'created', path, nodeKind });
	}

	function creatable(studio: StudioInfo) {
		return {
			table: canAlter(studio, 'create-table'),
			schema: canAlter(studio, 'create-schema') && studio.capabilities.schemas,
			collection: canAlter(studio, 'create-collection')
		};
	}

	// --- shortcuts -----------------------------------------------------------------------------

	let filterInput = $state<HTMLInputElement | null>(null);

	const modifier = (event: KeyboardEvent) => (event.metaKey || event.ctrlKey) && !event.altKey;

	/** ⌘/Ctrl+K focuses the tree filter. Bubble phase, so an editor's own ⌘K chords win. */
	function focusFilter(event: KeyboardEvent) {
		if (!modifier(event) || event.shiftKey || event.key.toLowerCase() !== 'k' || !filterInput) return;
		event.preventDefault();
		filterInput.focus();
		filterInput.select();
	}

	/**
	 * ⌘/Ctrl+Alt+N opens a query tab, wherever focus is. Not ⌘/Ctrl+Shift+N: browsers reserve it
	 * for a private window and never hand it to the page. `code` because Option+N is a dead key.
	 */
	function newQueryShortcut(event: KeyboardEvent) {
		if (!modifier(event) || !event.altKey || event.code !== 'KeyN' || !info.isSuccess) return;
		event.preventDefault();
		event.stopPropagation();
		newQuery();
	}

	// --- resizable tree ------------------------------------------------------------------------

	const WIDTH_KEY = 'yoal:studio:tree-width';
	const clampWidth = (value: number) => Math.min(520, Math.max(180, Math.round(value)));
	let treeWidth = $state(256);
	if (browser) {
		try {
			const saved = Number(localStorage.getItem(WIDTH_KEY));
			if (saved > 0) treeWidth = clampWidth(saved);
		} catch {
			// Storage blocked: default width.
		}
	}
	function setTreeWidth(value: number) {
		treeWidth = clampWidth(value);
		try {
			localStorage.setItem(WIDTH_KEY, String(treeWidth));
		} catch {
			// Not remembered.
		}
	}

	let dragFrom: { x: number; width: number } | null = null;
	function dragStart(event: PointerEvent) {
		dragFrom = { x: event.clientX, width: treeWidth };
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}
	function dragMove(event: PointerEvent) {
		if (dragFrom) setTreeWidth(dragFrom.width + event.clientX - dragFrom.x);
	}
	function dragEnd() {
		dragFrom = null;
	}
	function separatorKey(event: KeyboardEvent) {
		if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault();
			setTreeWidth(treeWidth + (event.key === 'ArrowLeft' ? -16 : 16));
		}
	}
</script>

<svelte:window onkeydown={focusFilter} onkeydowncapture={newQueryShortcut} />

<div class="flex h-[calc(100svh-13rem)] min-h-[560px] flex-col gap-3">
	<StudioHeader
		name={database}
		{engine}
		{readOnly}
		{expiresAt}
		info={info.data}
		{canWrite}
		onopenreadonly={openReadOnly}
		onenablewrites={() => confirmEnableWrites(database)}
		onclose={closeSession}
		onnewquery={() => newQuery()}
	/>

	{#if principal !== 'ready'}
		<PreparingAccess {nodeLabel} state={principal} error={principalError} onretry={openReadOnly} />
	{:else if info.isPending}
		<div class="flex items-center gap-2 py-10 text-sm text-muted-foreground" role="status">
			<Spinner class="size-4" />Connecting to the studio on {nodeLabel}…
		</div>
	{:else if info.isError}
		<StudioErrorNotice error={info.error} onretry={() => info.refetch()} />
	{:else if info.data}
		{@const studio = info.data}
		{@const can = creatable(studio)}
		<div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card md:flex-row">
			<div
				class="h-56 shrink-0 border-b md:h-auto md:w-(--tree-w) md:border-b-0"
				style="--tree-w: {treeWidth}px"
			>
				<ObjectTree
					{tree}
					label="Objects in {database}"
					{activePath}
					onopen={openObject}
					onreopen={openReadOnly}
					bind:filterInput
				>
					{#snippet actions()}
						{#if can.table || can.schema || can.collection}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button {...props} variant="ghost" size="icon-sm" aria-label="New object" title="New object">
											<PlusIcon />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									{#if can.table}
										<DropdownMenu.Item onSelect={() => (creatingTable = true)}>New table…</DropdownMenu.Item>
									{/if}
									{#if can.schema}
										<DropdownMenu.Item onSelect={() => (creatingSchema = true)}>New schema…</DropdownMenu.Item>
									{/if}
									{#if can.collection}
										<DropdownMenu.Item onSelect={() => (creatingCollection = true)}>New collection…</DropdownMenu.Item>
									{/if}
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						{/if}
					{/snippet}
				</ObjectTree>
			</div>
			<!-- A focusable separator is a widget (WAI-ARIA window splitter). -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize the object tree"
				aria-valuenow={treeWidth}
				aria-valuemin={180}
				aria-valuemax={520}
				tabindex="0"
				class="hidden w-1 shrink-0 cursor-col-resize touch-none border-l bg-transparent outline-none hover:bg-ring/30 focus-visible:bg-ring/50 md:block"
				onpointerdown={dragStart}
				onpointermove={dragMove}
				onpointerup={dragEnd}
				onpointercancel={dragEnd}
				onkeydown={separatorKey}
			></div>

			<section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Workspace">
				{#if tabs.tabs.length > 0}
					<TabStrip
						tabs={tabs.tabs}
						active={tabs.active}
						panelId={tabPanelDomId}
						onselect={(id) => (tabs = focusTab(tabs, id))}
						onclose={(id) => (tabs = closeTab(tabs, id))}
					/>
				{/if}
				{#each tabs.tabs as tab (tab.id)}
					<div
						id={tabPanelDomId(tab.id)}
						role="tabpanel"
						aria-labelledby={tabDomId(tab.id)}
						class="min-h-0 flex-1 flex-col overflow-hidden {tab.id === tabs.active ? 'flex' : 'hidden'}"
					>
						{#if tab.type === 'object'}
							{#if studio.capabilities.family === 'relational'}
								<RelationalWorkspace database={name} info={studio} object={tab.node} onquery={newQuery} />
							{:else if studio.capabilities.family === 'document'}
								<DocumentWorkspace database={name} info={studio} object={tab.node} onquery={newQuery} />
							{:else}
								<KeyValueWorkspace database={name} info={studio} object={tab.node} onquery={newQuery} />
							{/if}
						{:else}
							<QueryTab database={name} info={studio} initialInput={tab.input} />
						{/if}
					</div>
				{:else}
					<div class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
						<SquareTerminalIcon class="size-8 text-muted-foreground" />
						<div class="space-y-1">
							<p class="text-sm font-medium">Nothing open yet</p>
							<p class="max-w-sm text-sm text-muted-foreground">
								Choose {studio.capabilities.family === 'keyvalue'
									? 'a key'
									: studio.capabilities.family === 'document'
										? 'a collection'
										: 'a table'} in the tree, or start a query.
							</p>
						</div>
						<Button size="sm" variant="outline" onclick={() => newQuery()}>New query</Button>
						<p class="text-xs text-muted-foreground">
							<Kbd>⌘</Kbd><Kbd>K</Kbd> filter objects · <Kbd>⌘</Kbd><Kbd>⌥</Kbd><Kbd>N</Kbd> new query
						</p>
					</div>
				{/each}
			</section>
		</div>

		<CreateTableDialog
			bind:open={creatingTable}
			dialect={studio.capabilities.dialect}
			schemas={studio.capabilities.schemas ? schemaNames : []}
			schema={activeSchema}
			onsubmit={(change) => {
				if (change.op !== 'create-table') return;
				const path = [...(change.parent ?? []), change.name];
				void create(change, `table ${path.join('.')}`, path, 'table');
			}}
		/>
		<NameDialog
			bind:open={creatingSchema}
			title="New schema"
			submitLabel="Review"
			onsubmit={(schema) => void create({ op: 'create-schema', name: schema }, `schema ${schema}`, [schema], 'schema')}
		/>
		<NameDialog
			bind:open={creatingCollection}
			title="New collection"
			description="MongoDB also creates a collection the first time a document is inserted into it."
			submitLabel="Review"
			onsubmit={(collection) =>
				void create({ op: 'create-collection', name: collection }, `collection ${collection}`, [collection], 'collection')}
		/>
		<ReviewDialog {review} />
	{/if}
</div>

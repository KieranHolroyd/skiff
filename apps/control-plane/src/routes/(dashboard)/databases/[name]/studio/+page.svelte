<script lang="ts">
	import { browser } from '$app/env';
	import { onDestroy, untrack } from 'svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlayIcon from '@lucide/svelte/icons/play';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import SquareIcon from '@lucide/svelte/icons/square';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import TableIcon from '@lucide/svelte/icons/table';
	import XIcon from '@lucide/svelte/icons/x';
	import type { Cell, Column, ObjectRef, TreeNode } from '@skiff/studio/protocol';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { StudioCallError, studioCall, studioStream } from '#lib/studio/client.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import Panel from '../../../_lib/Panel.svelte';
	import DatabaseHeader from '../../_lib/DatabaseHeader.svelte';
	import ResultGrid from './_lib/ResultGrid.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const db = $derived(data.database);
	const can = $derived(data.dbCan);
	const deleted = $derived(db.deletedAt !== null);
	const session = $derived(data.studio?.active ? data.studio : null);

	function message(caught: unknown): string {
		if (caught instanceof StudioCallError) return caught.message;
		return caught instanceof Error ? caught.message : 'The studio request failed.';
	}

	// --- session -------------------------------------------------------------------------------

	let now = $state(Date.now());
	$effect(() => {
		if (!session?.expiresAt) return;
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});
	const remainingMs = $derived(session?.expiresAt ? Date.parse(session.expiresAt) - now : null);
	const expired = $derived(remainingMs !== null && remainingMs <= 0);

	function countdown(ms: number): string {
		const total = Math.max(0, Math.floor(ms / 1000));
		const hours = Math.floor(total / 3600);
		const minutes = Math.floor((total % 3600) / 60);
		const seconds = String(total % 60).padStart(2, '0');
		return hours > 0
			? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
			: `${minutes}:${seconds}`;
	}

	function open(readOnly: boolean) {
		if (!readOnly) {
			enableWrites();
			return;
		}
		void runAction('?/open', { readOnly: '1' });
	}

	function enableWrites() {
		askConfirm({
			title: `Enable writes for ${db.name}?`,
			description:
				'The studio connects with the owner credential and no read-only transaction. Every statement you run and every edit you apply changes the live database, including DELETE and DROP. Writes last for this session only.',
			confirmLabel: 'Enable writes',
			tone: 'danger',
			action: '?/open',
			fields: { readOnly: '0' }
		});
	}

	function close() {
		abortAll();
		void runAction('?/close');
	}

	// --- info ----------------------------------------------------------------------------------

	const info = createQuery(() => ({
		queryKey: ['studio-info', db.name, session?.sessionId ?? null, session?.readOnly ?? null],
		queryFn: ({ signal }) => studioCall(db.name, 'info', {}, signal),
		enabled: browser && session !== null && !expired,
		staleTime: Infinity,
		retry: false
	}));

	// --- tree ----------------------------------------------------------------------------------

	interface TreeItem {
		node: TreeNode;
		expanded: boolean;
		loading: boolean;
		error: string | null;
		children: TreeItem[] | null;
	}

	let roots = $state<TreeItem[] | null>(null);
	let rootsLoading = $state(false);
	let rootsError = $state<string | null>(null);
	let selected = $state<string | null>(null);

	const toItem = (node: TreeNode): TreeItem => ({
		node,
		expanded: false,
		loading: false,
		error: null,
		children: null
	});
	const pathKey = (path: string[]) => JSON.stringify(path);

	async function loadRoots() {
		rootsLoading = true;
		rootsError = null;
		try {
			const result = await studioCall(db.name, 'tree', { path: [] });
			roots = result.nodes.map(toItem);
		} catch (caught) {
			rootsError = message(caught);
		} finally {
			rootsLoading = false;
		}
	}

	async function expand(item: TreeItem) {
		item.expanded = !item.expanded;
		if (!item.expanded || item.children !== null || item.loading) return;
		item.loading = true;
		item.error = null;
		try {
			const result = await studioCall(db.name, 'tree', { path: item.node.path });
			item.children = result.nodes.map(toItem);
		} catch (caught) {
			item.error = message(caught);
			item.expanded = false;
		} finally {
			item.loading = false;
		}
	}

	function activate(item: TreeItem) {
		if (item.node.browsable) {
			selected = pathKey(item.node.path);
			tab = 'data';
			void browse({ path: item.node.path, kind: item.node.kind });
		}
		if (item.node.hasChildren) void expand(item);
	}

	// A new session (opened, mode switched) starts from a fresh tree and empty results.
	let treeFor: string | null = null;
	$effect(() => {
		const id = session?.sessionId ?? null;
		if (!browser || id === treeFor) return;
		treeFor = id;
		roots = null;
		rootsError = null;
		selected = null;
		untrack(() => {
			abortAll();
			resetBrowse();
			resetRun();
		});
	});
	// Load the top of the tree once `info` confirms the session answers.
	$effect(() => {
		if (browser && session && info.isSuccess && roots === null && !rootsLoading && !rootsError)
			untrack(() => void loadRoots());
	});

	// --- tabs ----------------------------------------------------------------------------------

	/** `data` or `query`. */
	let tab = $state('data');

	// --- data (browse) -------------------------------------------------------------------------

	let browseObject = $state<ObjectRef | null>(null);
	let browseColumns = $state.raw<Column[]>([]);
	let browseRows = $state.raw<Cell[][]>([]);
	let browseNext = $state<string | null>(null);
	let browseCursor = $state<string | undefined>(undefined);
	let browsePage = $state(1);
	let browseError = $state<string | null>(null);
	let browsing = $state(false);
	let browseMs = $state<number | null>(null);
	let browseController: AbortController | null = null;

	function resetBrowse() {
		browseController?.abort();
		browseObject = null;
		browseColumns = [];
		browseRows = [];
		browseNext = null;
		browseCursor = undefined;
		browsePage = 1;
		browseError = null;
		browseMs = null;
	}

	async function browse(object: ObjectRef, cursor?: string, page = 1) {
		browseController?.abort();
		const controller = new AbortController();
		browseController = controller;
		browseObject = object;
		browseCursor = cursor;
		browsePage = page;
		browseColumns = [];
		browseRows = [];
		browseNext = null;
		browseError = null;
		browseMs = null;
		browsing = true;
		try {
			for await (const event of studioStream(
				db.name,
				'browse',
				{ object, query: { limit: 100, ...(cursor ? { cursor } : {}) } },
				controller.signal
			)) {
				if (event.t === 'columns') browseColumns = event.columns;
				else if (event.t === 'rows') browseRows = browseRows.concat(event.rows);
				else if (event.t === 'page') browseNext = event.next;
				else if (event.t === 'error') browseError = event.message;
				else if (event.t === 'done') browseMs = event.ms;
			}
		} catch (caught) {
			if (!controller.signal.aborted) browseError = message(caught);
		} finally {
			if (browseController === controller) {
				browsing = false;
				browseController = null;
			}
		}
	}

	const browseLabel = $derived(browseObject ? browseObject.path.join('.') : '');

	// --- query (run) ---------------------------------------------------------------------------

	interface ResultSet {
		id: number;
		columns: Column[];
		rows: Cell[][];
		affected?: number;
		command?: string;
	}
	interface RunMessage {
		level: 'info' | 'warn' | 'error';
		text: string;
	}

	let input = $state('');
	let running = $state(false);
	let results = $state.raw<ResultSet[]>([]);
	let messages = $state.raw<RunMessage[]>([]);
	let runDone = $state<{ ms: number; truncated: boolean } | null>(null);
	let activeResult = $state('0');
	let runController: AbortController | null = null;

	function resetRun() {
		runController?.abort();
		results = [];
		messages = [];
		runDone = null;
		activeResult = '0';
	}

	async function run() {
		const text = input;
		if (!text.trim() || running || !session) return;
		resetRun();
		const controller = new AbortController();
		runController = controller;
		running = true;
		// The open result set: `columns` starts one, `result` ends it.
		let current: number | null = null;
		const update = (index: number, change: (set: ResultSet) => ResultSet) => {
			results = results.map((set, at) => (at === index ? change(set) : set));
		};
		try {
			for await (const event of studioStream(db.name, 'run', { input: text }, controller.signal)) {
				switch (event.t) {
					case 'columns':
						current = results.length;
						results = [...results, { id: current, columns: event.columns, rows: [] }];
						break;
					case 'rows':
						if (current !== null) {
							const rows = event.rows;
							update(current, (set) => ({ ...set, rows: set.rows.concat(rows) }));
						}
						break;
					case 'result':
						if (current !== null) {
							const { affected, command } = event;
							update(current, (set) => ({ ...set, affected, command }));
						} else {
							// A statement without rows (DML, DDL) still gets a result tab.
							results = [
								...results,
								{
									id: results.length,
									columns: [],
									rows: [],
									affected: event.affected,
									command: event.command
								}
							];
						}
						current = null;
						break;
					case 'notice':
						messages = [...messages, { level: event.level, text: event.message }];
						break;
					case 'error':
						messages = [
							...messages,
							{
								level: 'error',
								text:
									event.position !== undefined
										? `${event.message} (at character ${event.position})`
										: event.message
							}
						];
						break;
					case 'done':
						runDone = { ms: event.ms, truncated: event.truncated };
						break;
				}
			}
		} catch (caught) {
			messages = [
				...messages,
				controller.signal.aborted
					? { level: 'warn', text: 'Stopped. The query was cancelled on the database.' }
					: {
							level: 'error',
							text:
								caught instanceof StudioCallError && caught.code === 'studio_restarted'
									? 'The studio restarted while this ran. Run it again.'
									: message(caught)
						}
			];
		} finally {
			if (runController === controller) {
				running = false;
				runController = null;
			}
		}
	}

	function stop() {
		runController?.abort();
	}

	function onEditorKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void run();
		}
	}

	function abortAll() {
		browseController?.abort();
		runController?.abort();
	}

	onDestroy(abortAll);

	const numberFormat = new Intl.NumberFormat('en-GB');
</script>

<svelte:head>
	<title>Studio · {db.name} · Skiff</title>
</svelte:head>

<div class="space-y-4">
	<DatabaseHeader {db} {can} active="studio" nativeStudio />

	{#if !can.console}
		<Notice tone="warning" title="Studio access required">
			Opening the database studio needs <code class="font-mono">database:console</code>. Ask an
			owner if you need it.
		</Notice>
	{:else if deleted}
		<Notice tone="warning" title="This database is in the trash">
			Restore it to open the studio.
		</Notice>
	{:else if data.studioError}
		<Notice tone="danger" title="Could not read the studio session">{data.studioError}</Notice>
	{:else if !session}
		<Panel
			title="Database studio"
			icon={SquareTerminalIcon}
			description="Browse and query {db.name} from the dashboard. Nothing runs on the node until you open a session, and it closes itself when idle."
		>
			<EmptyState
				icon={SquareTerminalIcon}
				title="Open the database studio"
				description={`Sessions are read-only unless you enable writes, and expire after ${data.studio?.idleMinutes ?? 15} idle minutes.`}
			>
				<Button onclick={() => open(true)}><PlayIcon />Open read-only</Button>
				{#if data.canWrite}
					<Button variant="outline" onclick={() => open(false)}
						><PencilIcon />Open with writes</Button
					>
				{/if}
			</EmptyState>
		</Panel>
	{:else}
		<!-- Session bar ------------------------------------------------------------------------- -->
		<div
			class="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2"
			aria-label="Studio session"
			role="group"
		>
			{#if session.readOnly}
				<Badge variant="secondary"><ShieldCheckIcon />Read-only</Badge>
			{:else}
				<Badge variant="warning"><PencilIcon />Read-write</Badge>
			{/if}
			{#if info.data}
				<Badge variant="outline">{info.data.engine} {info.data.version}</Badge>
			{/if}
			{#if remainingMs !== null}
				<span class="text-xs text-muted-foreground" aria-live="off">
					{#if expired}
						Session expired
					{:else}
						Expires in <time class="font-mono tabular-nums" datetime={session.expiresAt}
							>{countdown(remainingMs)}</time
						>
					{/if}
				</span>
			{/if}
			<div class="ml-auto flex flex-wrap items-center gap-2">
				{#if expired}
					<Button size="sm" onclick={() => open(true)}><RefreshCwIcon />Open again</Button>
				{:else if session.readOnly && data.canWrite}
					<Button variant="outline" size="sm" onclick={enableWrites}>
						<PencilIcon />Enable writes
					</Button>
				{:else if !session.readOnly}
					<Button variant="outline" size="sm" onclick={() => open(true)}>
						<ShieldCheckIcon />Switch to read-only
					</Button>
				{/if}
				<Button variant="outline" size="sm" onclick={close}><XIcon />Close</Button>
			</div>
		</div>

		{#if info.isPending}
			<div class="flex items-center gap-2 py-10 text-sm text-muted-foreground" role="status">
				<Spinner class="size-4" />Connecting to the studio on {db.nodeName ?? db.nodeId}…
			</div>
		{:else if info.isError}
			<Notice tone="danger" title="The studio did not answer">
				<p>{message(info.error)}</p>
				<Button variant="outline" size="sm" class="mt-2" onclick={() => info.refetch()}>
					<RefreshCwIcon />Try again
				</Button>
			</Notice>
		{:else if info.data}
			{@const caps = info.data.capabilities}
			<p class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
				<span>Family <span class="font-mono text-foreground">{caps.family}</span></span>
				<span
					>Language <span class="font-mono text-foreground"
						>{caps.language}{caps.dialect ? ` (${caps.dialect})` : ''}</span
					></span
				>
				<span>Edit <span class="font-mono text-foreground">{caps.edit || 'no'}</span></span>
				<span>Cancel <span class="font-mono text-foreground">{caps.cancel}</span></span>
				<span
					>Explain <span class="font-mono text-foreground">{caps.explain ? 'yes' : 'no'}</span
					></span
				>
				<span
					>Limits <span class="font-mono text-foreground"
						>{numberFormat.format(info.data.limits.maxRows)} rows · {Math.round(
							info.data.limits.statementTimeoutMs / 1000
						)} s</span
					></span
				>
			</p>

			<div
				class="grid h-[calc(100vh-20rem)] min-h-[520px] gap-3 lg:grid-cols-[16rem_minmax(0,1fr)]"
			>
				<!-- Object tree ----------------------------------------------------------------------- -->
				<nav
					class="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card"
					aria-label="Objects in {db.name}"
				>
					<div class="flex items-center justify-between border-b px-3 py-2">
						<span class="text-xs font-medium text-muted-foreground">Objects</span>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Reload objects"
							onclick={() => void loadRoots()}
						>
							<RefreshCwIcon />
						</Button>
					</div>
					<div class="min-h-0 flex-1 overflow-auto p-1 text-sm">
						{#if rootsLoading && !roots}
							<div class="flex items-center gap-2 p-2 text-muted-foreground" role="status">
								<Spinner class="size-3.5" />Loading…
							</div>
						{:else if rootsError}
							<p class="p-2 text-xs text-destructive" role="alert">{rootsError}</p>
						{:else if roots && roots.length === 0}
							<p class="p-2 text-xs text-muted-foreground">No objects yet.</p>
						{:else if roots}
							<ul role="tree" aria-label="Objects">
								{@render branch(roots, 1)}
							</ul>
						{/if}
					</div>
				</nav>

				<!-- Workspace ------------------------------------------------------------------------- -->
				<Tabs.Root
					bind:value={tab}
					class="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card"
				>
					<Tabs.List variant="line" class="w-full justify-start border-b px-2">
						<Tabs.Trigger value="data" class="flex-none"><TableIcon />Data</Tabs.Trigger>
						<Tabs.Trigger value="query" class="flex-none"><SquareTerminalIcon />Query</Tabs.Trigger>
					</Tabs.List>

					<Tabs.Content value="data" class="flex min-h-0 flex-1 flex-col gap-2 p-3">
						{#if !browseObject}
							<p class="text-sm text-muted-foreground">
								Choose a table or collection in the tree to browse its rows.
							</p>
						{:else}
							<div class="flex flex-wrap items-center gap-2 text-xs">
								<span class="font-mono font-medium">{browseLabel}</span>
								<span class="text-muted-foreground">
									Page {browsePage}{browseRows.length > 0
										? ` · ${numberFormat.format(browseRows.length)} rows`
										: ''}{browseMs !== null ? ` · ${numberFormat.format(browseMs)} ms` : ''}
								</span>
								{#if browsing}<Spinner class="size-3.5" />{/if}
								<div class="ml-auto flex gap-2">
									{#if browseCursor}
										<Button
											variant="outline"
											size="sm"
											disabled={browsing}
											onclick={() => browseObject && void browse(browseObject)}
										>
											First page
										</Button>
									{/if}
									<Button
										variant="outline"
										size="sm"
										disabled={browsing || browseNext === null}
										onclick={() =>
											browseObject &&
											browseNext &&
											void browse(browseObject, browseNext, browsePage + 1)}
									>
										Next page<ChevronRightIcon />
									</Button>
								</div>
							</div>
							{#if browseError}
								<p class="text-xs text-destructive" role="alert">{browseError}</p>
							{/if}
							<div class="min-h-0 flex-1">
								{#if browseColumns.length > 0}
									<ResultGrid
										columns={browseColumns}
										rows={browseRows}
										label="Rows of {browseLabel}"
									/>
								{/if}
							</div>
						{/if}
					</Tabs.Content>

					<Tabs.Content value="query" class="flex min-h-0 flex-1 flex-col gap-2 p-3">
						<Label for="studio-input" class="sr-only">
							{caps.language === 'sql' ? 'SQL' : 'Command'} to run
						</Label>
						<Textarea
							id="studio-input"
							bind:value={input}
							onkeydown={onEditorKeydown}
							rows={6}
							spellcheck={false}
							autocomplete="off"
							class="min-h-32 resize-y font-mono text-xs"
							placeholder={caps.language === 'sql'
								? 'SELECT * FROM …'
								: caps.language === 'mongo'
									? 'db.collection.find({})'
									: 'GET key'}
						/>
						<div class="flex flex-wrap items-center gap-2">
							<Button size="sm" disabled={running || !input.trim()} onclick={() => void run()}>
								<PlayIcon />Run
							</Button>
							<Button variant="outline" size="sm" disabled={!running} onclick={stop}>
								<SquareIcon />Stop
							</Button>
							<span class="text-xs text-muted-foreground">
								<Kbd>⌘</Kbd>/<Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd> to run
							</span>
							{#if running}<Spinner class="size-3.5" />{/if}
							{#if runDone}
								<span class="ml-auto text-xs text-muted-foreground" role="status">
									Done in {numberFormat.format(runDone.ms)} ms{runDone.truncated
										? ' · results truncated at the session limit'
										: ''}
								</span>
							{/if}
						</div>

						{#if messages.length > 0}
							<ul class="space-y-1 text-xs" aria-label="Messages">
								{#each messages as item, index (index)}
									<li
										class={item.level === 'error'
											? 'text-destructive'
											: item.level === 'warn'
												? 'text-warning'
												: 'text-muted-foreground'}
										role={item.level === 'error' ? 'alert' : undefined}
									>
										{item.text}
									</li>
								{/each}
							</ul>
						{/if}

						{#if results.length > 0}
							<Tabs.Root bind:value={activeResult} class="flex min-h-0 flex-1 flex-col gap-2">
								<Tabs.List class="w-fit">
									{#each results as set (set.id)}
										<Tabs.Trigger value={String(set.id)}>
											Result {set.id + 1}
											{#if set.columns.length > 0}
												<span class="font-mono text-muted-foreground tabular-nums"
													>{numberFormat.format(set.rows.length)}</span
												>
											{/if}
										</Tabs.Trigger>
									{/each}
								</Tabs.List>
								{#each results as set (set.id)}
									<Tabs.Content value={String(set.id)} class="flex min-h-0 flex-1 flex-col gap-1">
										{#if set.command || set.affected !== undefined}
											<p class="font-mono text-xs text-muted-foreground">
												{set.command ?? 'OK'}{set.affected !== undefined
													? ` · ${numberFormat.format(set.affected)} affected`
													: ''}
											</p>
										{/if}
										{#if set.columns.length > 0}
											<div class="min-h-48 flex-1">
												<ResultGrid
													columns={set.columns}
													rows={set.rows}
													label="Result {set.id + 1}"
												/>
											</div>
										{/if}
									</Tabs.Content>
								{/each}
							</Tabs.Root>
						{/if}
					</Tabs.Content>
				</Tabs.Root>
			</div>
		{/if}
	{/if}
</div>

{#snippet branch(items: TreeItem[], level: number)}
	{#each items as item (pathKey(item.node.path))}
		{@const key = pathKey(item.node.path)}
		<li
			role="treeitem"
			aria-level={level}
			aria-expanded={item.node.hasChildren ? item.expanded : undefined}
			aria-selected={selected === key}
		>
			<button
				type="button"
				class="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none {selected ===
				key
					? 'bg-muted font-medium'
					: ''}"
				style="padding-left: {0.375 + (level - 1) * 0.875}rem"
				onclick={() => activate(item)}
				title={item.node.detail?.type ?? item.node.kind}
			>
				{#if item.node.hasChildren}
					<ChevronRightIcon
						class="size-3.5 shrink-0 text-muted-foreground transition-transform {item.expanded
							? 'rotate-90'
							: ''}"
					/>
				{:else}
					<span class="size-3.5 shrink-0"></span>
				{/if}
				{#if item.node.browsable}
					<TableIcon class="size-3.5 shrink-0 text-muted-foreground" />
				{:else if item.node.kind === 'database' || item.node.kind === 'keyspace'}
					<DatabaseIcon class="size-3.5 shrink-0 text-muted-foreground" />
				{:else}
					<FolderIcon class="size-3.5 shrink-0 text-muted-foreground" />
				{/if}
				<span class="truncate">{item.node.name}</span>
				{#if item.node.detail?.rows !== undefined}
					<span class="ml-auto pl-2 font-mono text-[0.625rem] text-muted-foreground tabular-nums"
						>{numberFormat.format(item.node.detail.rows)}</span
					>
				{/if}
				{#if item.loading}<Spinner class="ml-auto size-3" />{/if}
			</button>
			{#if item.error}
				<p class="px-2 text-xs text-destructive" role="alert">{item.error}</p>
			{/if}
			{#if item.expanded && item.children}
				<ul role="group">
					{@render branch(item.children, level + 1)}
				</ul>
			{/if}
		</li>
	{/each}
{/snippet}

<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import ListTreeIcon from '@lucide/svelte/icons/list-tree';
	import PlayIcon from '@lucide/svelte/icons/play';
	import SquareIcon from '@lucide/svelte/icons/square';
	import type { ExplainResult } from '@skiff/studio/protocol';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { StudioCallError, studioCall, studioStream } from '../client.js';
	import { createCompletionSource } from '../completion.js';
	import StudioEditor from '../editor/StudioEditor.svelte';
	import { absolutePosition, type RunTarget } from '../editor/positions.js';
	import StudioGrid from '../grid/StudioGrid.svelte';
	import { openHistory, type HistoryEntry } from '../history.js';
	import type { QueryTabProps } from '../ui-types.js';
	import { download, toCsv, toJson } from './export.js';
	import PlanTree from './PlanTree.svelte';
	import {
		applyEvent,
		emptyRun,
		errorTitle,
		resultTitle,
		rowCap,
		rowChoices,
		type RunMessage,
		type RunState
	} from './run-state.js';

	let { database, info, initialInput = '' }: QueryTabProps = $props();

	const caps = $derived(info.capabilities);
	const completion = $derived(createCompletionSource(database, info));
	const history = $derived(openHistory(database));
	const choices = $derived(rowChoices(info));
	const numberFormat = new Intl.NumberFormat('en-GB');

	let input = $state(untrack(() => initialInput));
	let maxRows = $state(untrack(() => Math.min(1_000, info.limits.maxRows)));
	let editor = $state<ReturnType<typeof StudioEditor> | null>(null);

	let outcome = $state.raw<RunState>(emptyRun());
	let failure = $state.raw<RunMessage | null>(null);
	let markers = $state.raw<Array<{ position: number; message: string }>>([]);
	let running = $state(false);
	let explaining = $state(false);
	let ranWithCap = $state(0);
	let plan = $state.raw<ExplainResult | null>(null);
	let activeTab = $state('0');
	let controller: AbortController | null = null;

	const busy = $derived(running || explaining);
	const activeResult = $derived(
		outcome.results.find((set) => String(set.id) === activeTab && set.columns.length > 0) ?? null
	);
	const placeholder = $derived(
		caps.language === 'sql'
			? 'SELECT * FROM …'
			: caps.language === 'mongo'
				? '{"find": "collection", "filter": {}}'
				: 'GET key'
	);

	// ---- history ------------------------------------------------------------------------------

	let entries = $state.raw<HistoryEntry[]>([]);

	async function loadHistory() {
		try {
			entries = await history.list();
		} catch {
			entries = [];
		}
	}

	$effect(() => {
		void history;
		untrack(() => void loadHistory());
	});

	function pickHistory(entry: HistoryEntry) {
		input = entry.input;
		editor?.focus();
	}

	async function clearHistory() {
		await history.clear().catch(() => undefined);
		await loadHistory();
	}

	function relativeTime(iso: string): string {
		const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
		if (!Number.isFinite(seconds) || seconds < 60) return 'just now';
		if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
		if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
		return new Date(iso).toLocaleDateString('en-GB');
	}

	function firstLine(text: string): string {
		const line = text.trim().split('\n')[0] ?? '';
		return line.length > 80 ? `${line.slice(0, 80)}…` : line;
	}

	// ---- run ----------------------------------------------------------------------------------

	function target(text?: string): RunTarget {
		const fromEditor = editor?.runTarget();
		if (fromEditor) return fromEditor;
		const fallback = text ?? input;
		return { text: fallback, offset: Math.max(0, input.indexOf(fallback)) };
	}

	function callFailure(caught: unknown, signal: AbortSignal): RunMessage {
		if (signal.aborted) return { level: 'warn', text: errorTitle('cancelled') ?? 'Stopped.' };
		if (caught instanceof StudioCallError) {
			const title = errorTitle(caught.code);
			return { level: 'error', code: caught.code, text: caught.message, ...(title ? { title } : {}) };
		}
		return {
			level: 'error',
			text: caught instanceof Error ? caught.message : 'The studio request failed.'
		};
	}

	async function run(text?: string) {
		if (busy) return;
		const what = target(text);
		if (!what.text.trim()) return;
		const source = input;
		const current = new AbortController();
		controller = current;
		running = true;
		outcome = emptyRun();
		failure = null;
		markers = [];
		plan = null;
		activeTab = '0';
		ranWithCap = rowCap(Number(maxRows), info);
		const started = Date.now();
		let ok = true;
		try {
			for await (const event of studioStream(
				database,
				'run',
				{ input: what.text, maxRows: ranWithCap },
				current.signal
			)) {
				outcome = applyEvent(outcome, event);
				if (event.t === 'error') {
					ok = false;
					if (event.position !== undefined && input === source)
						markers = [
							...markers,
							{
								position: absolutePosition(source, what, event.position),
								message: event.message
							}
						];
				}
			}
		} catch (caught) {
			ok = false;
			failure = callFailure(caught, current.signal);
		} finally {
			if (controller === current) {
				running = false;
				controller = null;
			}
			const first = outcome.results.find((set) => set.columns.length > 0) ?? outcome.results[0];
			if (first && !outcome.results.some((set) => String(set.id) === activeTab))
				activeTab = String(first.id);
			const rows = outcome.results.reduce(
				(sum, set) => sum + (set.columns.length > 0 ? set.rows.length : (set.affected ?? 0)),
				0
			);
			await history
				.add({
					input: what.text,
					ranAt: new Date(started).toISOString(),
					ms: outcome.done?.ms ?? Date.now() - started,
					rows,
					ok
				})
				.catch(() => undefined);
			await loadHistory();
		}
	}

	async function explain() {
		if (busy || !caps.explain) return;
		const what = target();
		if (!what.text.trim()) return;
		const current = new AbortController();
		controller = current;
		explaining = true;
		failure = null;
		try {
			plan = await studioCall(database, 'explain', { input: what.text }, current.signal);
			activeTab = 'plan';
		} catch (caught) {
			failure = callFailure(caught, current.signal);
		} finally {
			if (controller === current) {
				explaining = false;
				controller = null;
			}
		}
	}

	function stop() {
		controller?.abort();
	}

	function keydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && busy && !event.defaultPrevented) {
			event.preventDefault();
			stop();
		} else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.defaultPrevented) {
			// The editor handles its own shortcut; this covers focus in the toolbar or results.
			event.preventDefault();
			void run();
		}
	}

	onDestroy(stop);

	// ---- export -------------------------------------------------------------------------------

	function exportResult(format: 'csv' | 'json') {
		const set = activeResult;
		if (!set) return;
		const name = `${database}-result-${set.id + 1}`;
		if (format === 'csv') download(`${name}.csv`, toCsv(set.columns, set.rows), 'text/csv;charset=utf-8');
		else download(`${name}.json`, toJson(set.columns, set.rows), 'application/json');
	}

	// ---- split --------------------------------------------------------------------------------

	let split = $state(40);
	let splitContainer: HTMLDivElement;

	function resizeTo(clientY: number) {
		const rect = splitContainer.getBoundingClientRect();
		if (rect.height <= 0) return;
		split = Math.min(85, Math.max(15, ((clientY - rect.top) / rect.height) * 100));
	}

	function splitPointerDown(event: PointerEvent) {
		const handle = event.currentTarget as HTMLElement;
		handle.setPointerCapture(event.pointerId);
		event.preventDefault();
	}

	function splitPointerMove(event: PointerEvent) {
		const handle = event.currentTarget as HTMLElement;
		if (handle.hasPointerCapture(event.pointerId)) resizeTo(event.clientY);
	}

	function splitKeydown(event: KeyboardEvent) {
		const step = event.shiftKey ? 10 : 2;
		if (event.key === 'ArrowUp') split = Math.max(15, split - step);
		else if (event.key === 'ArrowDown') split = Math.min(85, split + step);
		else return;
		event.preventDefault();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex size-full min-h-0 flex-col" onkeydown={keydown}>
	<div class="flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
		<Button size="sm" disabled={busy || !input.trim()} onclick={() => void run()}>
			<PlayIcon />Run
		</Button>
		<Button variant="outline" size="sm" disabled={!busy} onclick={stop}>
			<SquareIcon />Stop
		</Button>
		{#if caps.explain}
			<Button variant="outline" size="sm" disabled={busy || !input.trim()} onclick={() => void explain()}>
				<ListTreeIcon />Explain
			</Button>
		{/if}
		<label class="ml-1 flex items-center gap-1.5 text-xs text-muted-foreground">
			Max rows
			<NativeSelect.Root size="sm" bind:value={maxRows} aria-label="Maximum rows">
				{#each choices as choice (choice)}
					<NativeSelect.Option value={choice}>{numberFormat.format(choice)}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
		</label>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="sm" aria-label="Query history">
						<HistoryIcon />History
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" class="max-h-96 w-96 overflow-y-auto">
				{#if entries.length === 0}
					<DropdownMenu.Label class="text-xs font-normal text-muted-foreground">
						Queries you run on {database} appear here.
					</DropdownMenu.Label>
				{:else}
					{#each entries as entry, index (index)}
						<DropdownMenu.Item onSelect={() => pickHistory(entry)} class="flex-col items-start gap-0.5">
							<span class="w-full truncate font-mono text-xs">{firstLine(entry.input)}</span>
							<span class="flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
								{#if entry.ok}
									<CircleCheckIcon class="size-3 text-success" />
								{:else}
									<CircleXIcon class="size-3 text-destructive" />
								{/if}
								{relativeTime(entry.ranAt)} · {numberFormat.format(entry.rows)} rows{entry.ms !== null
									? ` · ${numberFormat.format(entry.ms)} ms`
									: ''}
							</span>
						</DropdownMenu.Item>
					{/each}
					<DropdownMenu.Separator />
					<DropdownMenu.Item onSelect={() => void clearHistory()} class="text-xs">
						Clear history
					</DropdownMenu.Item>
				{/if}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
		<span class="ml-auto hidden text-xs text-muted-foreground sm:inline">
			<Kbd>⌘</Kbd>/<Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> runs the selection or all · <Kbd>Esc</Kbd> stops
		</span>
	</div>

	<div class="flex min-h-0 flex-1 flex-col" bind:this={splitContainer}>
		<div class="min-h-16 shrink-0" style:height="{split}%">
			<StudioEditor
				bind:this={editor}
				bind:value={input}
				language={caps.language}
				dialect={caps.dialect}
				{completion}
				{markers}
				onrun={(text) => void run(text)}
			/>
		</div>
		<!-- A focusable separator is the ARIA window-splitter pattern; Svelte's check doesn't know it. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			role="separator"
			aria-orientation="horizontal"
			aria-label="Resize editor and results"
			aria-valuemin={15}
			aria-valuemax={85}
			aria-valuenow={Math.round(split)}
			tabindex="0"
			class="h-1.5 shrink-0 cursor-row-resize border-y bg-muted/40 hover:bg-muted focus-visible:bg-ring/40 focus-visible:outline-none"
			onpointerdown={splitPointerDown}
			onpointermove={splitPointerMove}
			onkeydown={splitKeydown}
		></div>

		<section class="flex min-h-0 flex-1 flex-col gap-2 p-2" aria-label="Results">
			{#if busy || outcome.done || outcome.results.length > 0}
				<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="status">
					{#if running}
						<Spinner class="size-3.5" />Running…
					{:else if explaining}
						<Spinner class="size-3.5" />Explaining…
					{:else if outcome.done}
						<span>Done in {numberFormat.format(outcome.done.ms)} ms</span>
						{#if outcome.done.truncated}
							<Badge variant="warning">Showing the first {numberFormat.format(ranWithCap)} rows</Badge>
						{/if}
					{/if}
					{#if activeResult}
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button {...props} variant="ghost" size="xs" class="ml-auto">
										<DownloadIcon />Export
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="end">
								<DropdownMenu.Item onSelect={() => exportResult('csv')}>CSV</DropdownMenu.Item>
								<DropdownMenu.Item onSelect={() => exportResult('json')}>JSON</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					{/if}
				</div>
			{/if}

			{#each outcome.messages as item, index (index)}
				{#if item.level === 'error'}
					<Notice tone="danger" title={item.title ?? 'The statement failed'}>
						{item.text}{item.position !== undefined ? ' (marked in the editor)' : ''}
					</Notice>
				{:else}
					<p
						class="font-mono text-xs {item.level === 'warn' ? 'text-warning' : 'text-muted-foreground'}"
					>
						{item.level === 'warn' ? 'Warning: ' : ''}{item.text}
					</p>
				{/if}
			{/each}
			{#if failure}
				<Notice
					tone={failure.level === 'error' ? 'danger' : 'warning'}
					title={failure.title ?? (failure.level === 'error' ? 'The request failed' : undefined)}
				>
					{failure.text}
				</Notice>
			{/if}

			{#if outcome.results.length > 0 || plan}
				<Tabs.Root bind:value={activeTab} class="flex min-h-0 flex-1 flex-col gap-2">
					<Tabs.List class="w-fit max-w-full overflow-x-auto">
						{#each outcome.results as set (set.id)}
							<Tabs.Trigger value={String(set.id)} class="font-mono text-xs">
								{resultTitle(set)}
							</Tabs.Trigger>
						{/each}
						{#if plan}
							<Tabs.Trigger value="plan" class="text-xs">Plan</Tabs.Trigger>
						{/if}
					</Tabs.List>
					{#each outcome.results as set (set.id)}
						<Tabs.Content value={String(set.id)} class="flex min-h-0 flex-1 flex-col">
							{#if set.columns.length > 0}
								<div class="min-h-0 flex-1">
									<StudioGrid
										columns={set.columns}
										rows={set.rows}
										label={resultTitle(set)}
										loading={running && outcome.open === set.id}
									/>
								</div>
							{:else}
								<p class="font-mono text-xs text-muted-foreground">
									{set.command ?? 'OK'}{set.affected !== undefined
										? ` · ${numberFormat.format(set.affected)} affected`
										: ''}
								</p>
							{/if}
						</Tabs.Content>
					{/each}
					{#if plan}
						<Tabs.Content value="plan" class="min-h-0 flex-1 overflow-auto rounded-md border p-2">
							{#if plan.format === 'json'}
								<PlanTree value={plan.plan} />
							{:else}
								<pre class="font-mono text-xs whitespace-pre">{typeof plan.plan === 'string'
										? plan.plan
										: JSON.stringify(plan.plan, null, 2)}</pre>
							{/if}
						</Tabs.Content>
					{/if}
				</Tabs.Root>
			{:else if !busy && !outcome.done && !failure && outcome.messages.length === 0}
				<p class="m-auto text-center text-xs text-muted-foreground">
					Write a {caps.language === 'sql' ? 'query' : 'command'} above and run it, for example
					<code class="font-mono">{placeholder}</code>
				</p>
			{/if}
		</section>
	</div>
</div>

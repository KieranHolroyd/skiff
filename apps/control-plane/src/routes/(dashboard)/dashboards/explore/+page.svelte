<script lang="ts">
	/**
	 * Explore (D101): run one ad-hoc query over a time range and look at the result as a chart or
	 * a table, with the schema alongside. Queries are kept in this browser's history and in the
	 * URL; "Add to dashboard" turns the query into a panel.
	 */
	import { goto, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { browser } from '$app/env';
	import {
		panelQuerySchema,
		type DashboardPanel,
		type PanelQuery,
		type QueryResult,
		type VizType
	} from '@skiff/contracts';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import ChartLineIcon from '@lucide/svelte/icons/chart-line';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import TableIcon from '@lucide/svelte/icons/table';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { errorText } from '#lib/query.js';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import { formatBytes, formatRelative } from '../../_lib/format.js';
	import {
		createDashboard,
		getDashboard,
		getSchema,
		keys,
		listDashboards,
		updateDashboard
	} from '../_lib/api.js';
	import { findSpot } from '../_lib/grid.js';
	import { clearHistory, pushHistory, readHistory, type HistoryEntry } from '../_lib/history.js';
	import {
		clone,
		columnUnits,
		defaultBuilder,
		newId,
		querySummary,
		suggestedUnit
	} from '../_lib/panel.js';
	import { createPanelQuery } from '../_lib/panel-query.svelte.js';
	import QueryEditor from '../_lib/QueryEditor.svelte';
	import RefreshPicker from '../_lib/RefreshPicker.svelte';
	import SchemaBrowser from '../_lib/SchemaBrowser.svelte';
	import TelemetryState from '../_lib/TelemetryState.svelte';
	import TimeRangePicker from '../_lib/TimeRangePicker.svelte';
	import { formatInterval, resolveRange, type TimeRange } from '../_lib/time.js';
	import PanelViz from '../_lib/viz/PanelViz.svelte';

	const queryClient = useQueryClient();
	const schemaQuery = createQuery(() => ({
		queryKey: keys.schema,
		queryFn: ({ signal }) => getSchema(signal),
		staleTime: 60_000
	}));
	const schema = $derived(schemaQuery.data);

	function fromUrl(): { range: TimeRange; query: PanelQuery | null } {
		if (!browser) return { range: { from: 'now-6h', to: 'now' }, query: null };
		const params = new URL(window.location.href).searchParams;
		const from = params.get('from');
		const to = params.get('to');
		let query: PanelQuery | null = null;
		try {
			const raw = params.get('q');
			if (raw) {
				const parsed = panelQuerySchema.safeParse(JSON.parse(raw));
				if (parsed.success) query = parsed.data;
			}
		} catch {
			// A hand-edited link; start fresh.
		}
		return { range: from && to ? { from, to } : { from: 'now-6h', to: 'now' }, query };
	}

	const initial = fromUrl();
	let range = $state<TimeRange>(initial.range);
	let now = $state(Date.now());
	const resolved = $derived(resolveRange(range, now));
	let query = $state<PanelQuery>(
		initial.query ?? { mode: 'builder', builder: defaultBuilder(undefined) }
	);
	let ran = $state<PanelQuery | undefined>(initial.query ? clone(initial.query) : undefined);
	let view = $state<'chart' | 'table'>('chart');
	let width = $state(0);
	// Read once on the client (the page does not server-render); updated on every run.
	let history = $state<HistoryEntry[]>(browser ? readHistory() : []);
	let editor: QueryEditor | undefined = $state();

	// Once the schema arrives, give a fresh page a sensible starting query.
	let seeded = initial.query !== null;
	$effect(() => {
		if (seeded || !schema) return;
		seeded = true;
		query = { mode: 'builder', builder: defaultBuilder(schema.datasets[0]) };
		run();
	});

	const data = createPanelQuery(() => ({ query: ran, range: resolved, width, variables: {} }));
	const result = $derived(data.data as QueryResult | undefined);
	const error = $derived(data.error ? errorText(data.error, 'The query failed.') : null);
	const hasTime = $derived(result?.columns.some((column) => column.kind === 'time') ?? false);

	let timer: ReturnType<typeof setTimeout> | undefined;
	function change(next: PanelQuery) {
		query = next;
		clearTimeout(timer);
		if (next.mode === 'builder') timer = setTimeout(run, 500);
	}

	function run() {
		clearTimeout(timer);
		const next = clone(query);
		if (JSON.stringify(next) === JSON.stringify(ran)) void data.refetch();
		else ran = next;
		history = pushHistory(next);
		if (browser) {
			const params = new URLSearchParams({
				from: range.from,
				to: range.to,
				q: JSON.stringify(next)
			});
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only the query string changes
			replaceState(`${window.location.pathname}?${params}`, {});
		}
	}

	function setRange(next: TimeRange) {
		range = next;
		now = Date.now();
		if (browser && ran) {
			const params = new URLSearchParams({ from: next.from, to: next.to, q: JSON.stringify(ran) });
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only the query string changes
			replaceState(`${window.location.pathname}?${params}`, {});
		}
	}

	const dataset = $derived(
		query.mode === 'builder'
			? schema?.datasets.find(
					(item) => query.mode === 'builder' && item.name === query.builder.dataset
				)
			: undefined
	);
	const unit = $derived(
		query.mode === 'builder' ? (suggestedUnit(dataset, query.builder) ?? 'short') : 'short'
	);
	const previewPanel = $derived<Pick<DashboardPanel, 'viz' | 'options' | 'title'>>({
		viz: view === 'table' || !hasTime ? (view === 'table' ? 'table' : 'bar') : 'timeseries',
		title: 'Explore',
		options: view === 'table' ? { legend: 'bottom' } : { unit, legend: 'bottom' }
	});

	// --- add to dashboard ---------------------------------------------------------------------

	let addOpen = $state(false);
	let target = $state('new');
	let newTitle = $state('Explore');
	let panelTitle = $state('');
	let adding = $state(false);
	const dashboards = createQuery(() => ({
		queryKey: keys.dashboards,
		queryFn: ({ signal }) => listDashboards(signal),
		enabled: browser && addOpen
	}));
	const editable = $derived((dashboards.data ?? []).filter((item) => item.canEdit));

	function openAdd() {
		panelTitle = querySummary(ran ?? query).slice(0, 80);
		addOpen = true;
	}

	async function addToDashboard(event: SubmitEvent) {
		event.preventDefault();
		const panelQuery = clone(ran ?? query);
		const viz: VizType = hasTime ? 'timeseries' : 'table';
		const panel: DashboardPanel = {
			id: newId(),
			title: panelTitle.trim(),
			description: '',
			viz,
			gridPos: { x: 0, y: 0, w: 12, h: 8 },
			query: panelQuery,
			options: { unit }
		};
		adding = true;
		try {
			let id: string;
			if (target === 'new') {
				const created = await createDashboard({
					title: newTitle.trim() || 'Explore',
					spec: { panels: [panel] }
				});
				id = created.id;
			} else {
				const current = await getDashboard(target);
				const spot = findSpot(
					current.spec.panels.map((item) => ({ id: item.id, ...item.gridPos })),
					12,
					8
				);
				panel.gridPos = { ...panel.gridPos, ...spot };
				const updated = await updateDashboard(current.id, {
					version: current.version,
					spec: { ...current.spec, panels: [...current.spec.panels, panel] }
				});
				id = updated.id;
				queryClient.setQueryData(keys.dashboard(id), updated);
			}
			void queryClient.invalidateQueries({ queryKey: keys.dashboards });
			addOpen = false;
			toast.success('Panel added');
			await goto(resolve('/(dashboard)/dashboards/[id]', { id }));
		} catch (failure) {
			toast.error(errorText(failure, 'Could not add the panel.'));
		} finally {
			adding = false;
		}
	}

	function restore(entry: HistoryEntry) {
		query = clone(entry.query);
		run();
	}
</script>

<svelte:head><title>Explore · Dashboards · Skiff</title></svelte:head>

<div class="space-y-4">
	<PageHeader
		title="Explore"
		description="Ad-hoc queries over the telemetry store. Turn a useful one into a dashboard panel."
	>
		<TimeRangePicker value={range} onchange={setRange} />
		<RefreshPicker
			value={null}
			busy={data.isFetching}
			onchange={() => {}}
			onrefresh={() => ((now = Date.now()), run())}
		/>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="outline" aria-label="Query history"
						><HistoryIcon />History</Button
					>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-96 max-w-[calc(100vw-2rem)]">
				{#each history as entry (entry.at)}
					<DropdownMenu.Item onSelect={() => restore(entry)} class="flex-col items-start gap-0">
						<span class="w-full truncate font-mono text-xs">{querySummary(entry.query)}</span>
						<span class="text-[11px] text-muted-foreground"
							>{entry.query.mode} · {formatRelative(entry.at)}</span
						>
					</DropdownMenu.Item>
				{:else}
					<p class="px-2 py-1.5 text-xs text-muted-foreground">Queries you run appear here.</p>
				{/each}
				{#if history.length > 0}
					<DropdownMenu.Separator />
					<DropdownMenu.Item onSelect={() => ((history = []), clearHistory())}
						>Clear history</DropdownMenu.Item
					>
				{/if}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
		<Button onclick={openAdd} disabled={!ran}><LayoutDashboardIcon />Add to dashboard</Button>
	</PageHeader>

	<TelemetryState {schema} editable={false} large />

	{#if schema?.installed !== false}
		<div class="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
			<aside
				class="order-last max-h-[70vh] overflow-y-auto rounded-xl border bg-card p-3 lg:order-first lg:max-h-[calc(100svh-12rem)]"
				aria-label="Schema"
			>
				{#if schema}
					<SchemaBrowser
						{schema}
						oninsert={query.mode === 'sql' ? (text) => editor?.insert(text) : undefined}
					/>
				{:else}
					<Skeleton class="h-40" />
				{/if}
			</aside>

			<div class="min-w-0 space-y-4">
				<section class="rounded-xl border bg-card p-4" aria-label="Query">
					<QueryEditor
						bind:this={editor}
						{query}
						{schema}
						range={resolved}
						lastSql={result?.sql ?? null}
						running={data.isFetching}
						onchange={change}
						onrun={run}
						editorClass="h-48"
					/>
				</section>

				<section class="rounded-xl border bg-card" aria-label="Result" bind:clientWidth={width}>
					<header class="flex flex-wrap items-center gap-2 border-b px-4 py-2">
						<div
							class="inline-flex rounded-lg bg-muted p-0.5"
							role="tablist"
							aria-label="Result view"
						>
							<button
								type="button"
								role="tab"
								aria-selected={view === 'chart'}
								class="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium {view ===
								'chart'
									? 'bg-background shadow-xs'
									: 'text-muted-foreground'}"
								onclick={() => (view = 'chart')}><ChartLineIcon class="size-3.5" />Chart</button
							>
							<button
								type="button"
								role="tab"
								aria-selected={view === 'table'}
								class="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium {view ===
								'table'
									? 'bg-background shadow-xs'
									: 'text-muted-foreground'}"
								onclick={() => (view = 'table')}><TableIcon class="size-3.5" />Table</button
							>
						</div>
						{#if result}
							<span class="ml-auto font-mono text-[11px] text-muted-foreground">
								{result.rows.length.toLocaleString('en-GB')} rows · {result.stats.elapsedMs} ms · {formatBytes(
									result.stats.bytesRead
								)} read{#if result.intervalSeconds}
									· {formatInterval(result.intervalSeconds)}{/if}{#if result.resolution}
									· {result.resolution} table{/if}{#if result.truncated}
									· truncated{/if}
							</span>
						{/if}
					</header>
					<div class="h-[min(55vh,30rem)] p-3">
						{#if error}
							<div
								class="flex size-full flex-col items-center justify-center gap-2 overflow-auto text-center"
								role="alert"
							>
								<CircleAlertIcon class="size-5 text-destructive" />
								<p
									class="max-w-2xl font-mono text-xs break-words whitespace-pre-wrap text-destructive"
								>
									{error}
								</p>
							</div>
						{:else if !ran}
							<p class="grid size-full place-items-center text-sm text-muted-foreground">
								Build a query and press Run.
							</p>
						{:else if !result}
							<Skeleton class="size-full" />
						{:else if result.rows.length === 0}
							<p class="grid size-full place-items-center text-sm text-muted-foreground">
								No data in this range.
							</p>
						{:else if resolved}
							{#if result.notice}<p class="pb-1 text-xs text-warning">{result.notice}</p>{/if}
							<PanelViz
								panel={previewPanel}
								{result}
								names={schema?.names}
								range={resolved}
								columnUnits={columnUnits(ran, schema)}
								onzoom={(from, to) =>
									setRange({ from: new Date(from).toISOString(), to: new Date(to).toISOString() })}
							/>
						{/if}
					</div>
				</section>
			</div>
		</div>
	{/if}
</div>

<Dialog.Root bind:open={addOpen}>
	<Dialog.Content>
		<form class="contents" onsubmit={addToDashboard}>
			<Dialog.Header>
				<Dialog.Title>Add to dashboard</Dialog.Title>
				<Dialog.Description
					>The query becomes a {hasTime ? 'time series' : 'table'} panel; edit it there to change the
					visualisation.</Dialog.Description
				>
			</Dialog.Header>
			<label class="block space-y-1.5">
				<span class="text-sm font-medium">Panel title</span>
				<Input bind:value={panelTitle} maxlength={200} />
			</label>
			<label class="block space-y-1.5">
				<span class="text-sm font-medium">Dashboard</span>
				<NativeSelect.Root class="w-full" bind:value={target}>
					<NativeSelect.Option value="new">New dashboard…</NativeSelect.Option>
					{#each editable as item (item.id)}
						<NativeSelect.Option value={item.id}>{item.title}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
			</label>
			{#if target === 'new'}
				<label class="block space-y-1.5">
					<span class="text-sm font-medium">New dashboard title</span>
					<Input bind:value={newTitle} maxlength={120} required />
				</label>
			{/if}
			<Dialog.Footer>
				<Dialog.Close
					>{#snippet child({ props })}<Button {...props} variant="outline">Cancel</Button
						>{/snippet}</Dialog.Close
				>
				<Button type="submit" disabled={adding}
					>{#if adding}<Spinner />{/if}Add panel</Button
				>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

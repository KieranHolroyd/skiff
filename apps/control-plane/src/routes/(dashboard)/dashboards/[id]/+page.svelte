<script lang="ts">
	/**
	 * One observability dashboard. View mode shows the panels for the chosen time range and
	 * variables (both kept in the URL, so links are shareable). Edit mode adds dragging,
	 * resizing, the panel editor and settings; nothing is stored until Save, which sends the
	 * version the edit started from (a stale one is a 409).
	 */
	import { beforeNavigate, goto, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { browser } from '$app/env';
	import type {
		DashboardPanel,
		DashboardSpec,
		DashboardView,
		QueryResult,
		VizType
	} from '@skiff/contracts';
	import { createQuery, useIsFetching, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SaveIcon from '@lucide/svelte/icons/save';
	import Settings2Icon from '@lucide/svelte/icons/settings-2';
	import TypeIcon from '@lucide/svelte/icons/type';
	import Undo2Icon from '@lucide/svelte/icons/undo-2';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { HttpError, errorText } from '#lib/query.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import { formatRelative } from '../../_lib/format.js';
	import { getDashboard, getSchema, keys, updateDashboard } from '../_lib/api.js';
	import ConfirmDialog, { confirmAction } from '../_lib/ConfirmDialog.svelte';
	import DashboardGrid from '../_lib/DashboardGrid.svelte';
	import DashboardSettings, { type DashboardMeta } from '../_lib/DashboardSettings.svelte';
	import { findSpot, spotBeside, type GridItem } from '../_lib/grid.js';
	import InspectDialog from '../_lib/InspectDialog.svelte';
	import { clone, columnUnits, newId, newPanel, normalizeSpec, VIZ } from '../_lib/panel.js';
	import PanelCard from '../_lib/PanelCard.svelte';
	import PanelEditor from '../_lib/PanelEditor.svelte';
	import RefreshPicker from '../_lib/RefreshPicker.svelte';
	import TelemetryState from '../_lib/TelemetryState.svelte';
	import TimeRangePicker from '../_lib/TimeRangePicker.svelte';
	import { absolute, parseDuration, resolveRange, type TimeRange } from '../_lib/time.js';
	import { readUrlState, variableValues, writeUrlState } from '../_lib/variables.js';
	import VariablesBar from '../_lib/VariablesBar.svelte';

	const id = $derived(page.params.id ?? '');
	const queryClient = useQueryClient();

	const schemaQuery = createQuery(() => ({
		queryKey: keys.schema,
		queryFn: ({ signal }) => getSchema(signal),
		staleTime: 60_000
	}));
	const schema = $derived(schemaQuery.data);

	const dashboardQuery = createQuery(() => ({
		queryKey: keys.dashboard(id),
		queryFn: ({ signal }) => getDashboard(id, signal),
		enabled: browser && id !== '',
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		retry: false
	}));

	// --- the working copy ---------------------------------------------------------------------

	let base = $state<DashboardView | null>(null);
	let meta = $state<DashboardMeta>({ title: '', description: '', tags: [] });
	let spec = $state<DashboardSpec>(normalizeSpec(undefined));
	let saved = $state('');
	let editing = $state(false);

	/** What Save would store, minus the view state (time, refresh, variable picks). */
	function fingerprint(m: DashboardMeta, s: DashboardSpec): string {
		return JSON.stringify({
			m,
			panels: s.panels,
			variables: s.variables.map((variable) => ({ ...variable, current: [] }))
		});
	}
	const dirty = $derived(base !== null && fingerprint(meta, spec) !== saved);

	function load(view: DashboardView) {
		base = view;
		meta = { title: view.title, description: view.description, tags: [...view.tags] };
		spec = normalizeSpec(clone(view.spec));
		saved = fingerprint(meta, spec);
		applyUrl();
	}

	$effect(() => {
		const view = dashboardQuery.data;
		if (view && (!base || base.id !== view.id || base.version !== view.version)) load(view);
	});

	// --- view state: time range, refresh and variables, mirrored into the URL -----------------

	let range = $state<TimeRange>({ from: 'now-6h', to: 'now' });
	let refresh = $state<string | null>(null);
	let now = $state(Date.now());
	let options = $state<Record<string, string[]>>({});

	function applyUrl() {
		const url = readUrlState(new URL(browser ? window.location.href : page.url.href).searchParams);
		range = url.range ?? { ...spec.time };
		refresh = url.refresh === undefined ? spec.refresh : url.refresh;
		for (const variable of spec.variables) {
			const picked = url.vars[variable.name];
			if (picked) variable.current = picked;
		}
		now = Date.now();
	}

	const resolved = $derived(resolveRange(range, now));
	const values = $derived(variableValues(spec.variables, options));
	const variableNames = $derived(spec.variables.map((variable) => variable.name));

	$effect(() => {
		if (!browser || !base) return;
		const next = writeUrlState(new URL(window.location.href).searchParams, {
			range,
			refresh,
			variables: spec.variables
		});
		const search = `?${next.toString()}`;
		if (search === window.location.search) return;
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only the query string changes
		replaceState(`${window.location.pathname}${search}`, {});
	});

	function setRange(next: TimeRange) {
		range = next;
		now = Date.now();
	}

	function refreshNow() {
		now = Date.now();
		void queryClient.invalidateQueries({ queryKey: ['observability', 'query'] });
		// A store that was down may be back: check again rather than wait out the cached schema.
		if (schema && schema.installed && !schema.available)
			void queryClient.invalidateQueries({ queryKey: keys.schema });
	}

	$effect(() => {
		const every = parseDuration(refresh);
		if (!every || !browser) return;
		const timer = setInterval(refreshNow, Math.max(every, 5_000));
		return () => clearInterval(timer);
	});

	const fetchingCount = useIsFetching({ queryKey: ['observability', 'query'] });
	const fetching = $derived(fetchingCount.current > 0);

	function setVariable(name: string, current: string[]) {
		const variable = spec.variables.find((item) => item.name === name);
		if (variable) variable.current = current;
	}

	// --- editing ------------------------------------------------------------------------------

	const canEdit = $derived(base?.canEdit ?? false);
	let editorPanel = $state<DashboardPanel | null>(null);
	let editorOpen = $state(false);
	let settingsOpen = $state(false);
	let viewPanel = $state<DashboardPanel | null>(null);
	let inspect = $state<{
		panel: DashboardPanel;
		result: QueryResult | undefined;
		error: string | null;
	} | null>(null);
	let inspectOpen = $state(false);

	function layoutChanged(items: GridItem[]) {
		const byId = new Map(items.map((item) => [item.id, item]));
		spec.panels = spec.panels.map((panel) => {
			const item = byId.get(panel.id);
			return item ? { ...panel, gridPos: { x: item.x, y: item.y, w: item.w, h: item.h } } : panel;
		});
	}

	const layout = () => spec.panels.map((panel) => ({ id: panel.id, ...panel.gridPos }));

	function addPanel(viz: VizType) {
		editing = true;
		const size = viz === 'text' ? { w: 12, h: 4 } : { w: 12, h: 8 };
		const spot = findSpot(layout(), size.w, size.h);
		const panel = newPanel(viz, spot, schema?.datasets[0]);
		spec.panels = [...spec.panels, panel];
		openEditor(panel);
	}

	function openEditor(panel: DashboardPanel) {
		editorPanel = clone(panel);
		editorOpen = true;
	}

	function applyPanel(next: DashboardPanel) {
		spec.panels = spec.panels.map((panel) => (panel.id === next.id ? next : panel));
	}

	function duplicate(panel: DashboardPanel) {
		const copy = {
			...clone(panel),
			id: newId(),
			title: panel.title ? `${panel.title} (copy)` : ''
		};
		const spot = spotBeside(layout(), { id: panel.id, ...panel.gridPos });
		copy.gridPos = { ...copy.gridPos, ...spot };
		spec.panels = [...spec.panels, copy];
		editing = true;
	}

	function remove(panel: DashboardPanel) {
		confirmAction({
			title: `Remove ${panel.title ? `“${panel.title}”` : 'this panel'}?`,
			description: 'It is removed from the dashboard when you save.',
			confirmLabel: 'Remove',
			tone: 'danger',
			run: () => {
				spec.panels = spec.panels.filter((item) => item.id !== panel.id);
				editing = true;
			}
		});
	}

	function zoom(from: number, to: number) {
		setRange(absolute(from, to));
	}

	function discard() {
		if (base) load(base);
		editing = false;
	}

	// --- saving -------------------------------------------------------------------------------

	let saving = $state(false);
	let conflict = $state<string | null>(null);

	function specToSave(): DashboardSpec {
		return { ...clone(spec), time: { ...range }, refresh };
	}

	async function save(overwrite = false) {
		if (!base || saving) return;
		if (!meta.title.trim()) {
			toast.error('Give the dashboard a title first.');
			return;
		}
		saving = true;
		try {
			let version = base.version;
			if (overwrite) version = (await getDashboard(base.id)).version;
			const view = await updateDashboard(base.id, {
				title: meta.title.trim(),
				description: meta.description,
				tags: meta.tags,
				spec: specToSave(),
				version
			});
			conflict = null;
			queryClient.setQueryData(keys.dashboard(view.id), view);
			void queryClient.invalidateQueries({ queryKey: keys.dashboards });
			base = view;
			saved = fingerprint(meta, spec);
			editing = false;
			toast.success('Dashboard saved');
		} catch (error) {
			if (error instanceof HttpError && error.status === 409) conflict = error.message;
			else toast.error(errorText(error, 'Could not save the dashboard.'));
		} finally {
			saving = false;
		}
	}

	async function reloadLatest() {
		conflict = null;
		const view = await queryClient.fetchQuery({
			queryKey: keys.dashboard(id),
			queryFn: () => getDashboard(id),
			staleTime: 0
		});
		load(view);
		editing = false;
	}

	function exportJson() {
		const body = JSON.stringify(
			{ title: meta.title, description: meta.description, tags: meta.tags, spec: specToSave() },
			null,
			2
		);
		const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
		const link = document.createElement('a');
		link.href = url;
		link.download = `${meta.title.replace(/[^\w-]+/g, '-').toLowerCase() || 'dashboard'}.json`;
		link.click();
		URL.revokeObjectURL(url);
	}

	// --- leaving with unsaved changes ---------------------------------------------------------

	let leaving = $state<URL | null>(null);
	let allowLeave = false;
	beforeNavigate((navigation) => {
		if (!dirty || allowLeave || saving) return;
		if (navigation.type === 'leave') {
			navigation.cancel();
			return;
		}
		if (navigation.to?.url && navigation.to.url.pathname === window.location.pathname) return;
		navigation.cancel();
		if (navigation.to?.url) leaving = navigation.to.url;
	});

	function leave() {
		const target = leaving;
		leaving = null;
		allowLeave = true;
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- target came from the router
		if (target) void goto(target.href);
	}

	const notFound = $derived(
		dashboardQuery.error instanceof HttpError && dashboardQuery.error.status === 404
	);
</script>

<svelte:head>
	<title>{meta.title || 'Dashboard'} · Skiff</title>
</svelte:head>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 's' && (event.metaKey || event.ctrlKey) && editing) {
			event.preventDefault();
			void save();
		}
	}}
/>

{#if dashboardQuery.error && !base}
	<EmptyState
		title={notFound ? 'Dashboard not found' : 'Could not load the dashboard'}
		description={notFound ? 'It may have been deleted.' : errorText(dashboardQuery.error)}
		icon={LayoutDashboardIcon}
	>
		<Button variant="outline" href={resolve('/(dashboard)/dashboards')}>All dashboards</Button>
	</EmptyState>
{:else if !base}
	<div class="space-y-4">
		<Skeleton class="h-9 w-72" />
		<div class="grid grid-cols-2 gap-2">
			<Skeleton class="h-64" /><Skeleton class="h-64" /><Skeleton class="h-48" /><Skeleton
				class="h-48"
			/>
		</div>
	</div>
{:else}
	<div class="space-y-4">
		<header class="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
			<div class="min-w-0 space-y-1">
				{#if editing}
					<Input
						bind:value={meta.title}
						class="h-9 w-[min(28rem,80vw)] text-lg font-semibold"
						aria-label="Dashboard title"
						maxlength={120}
					/>
				{:else}
					<h1 class="truncate text-2xl font-semibold tracking-tight">{meta.title}</h1>
				{/if}
				<div class="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
					{#each meta.tags as tag (tag)}<Badge variant="secondary">{tag}</Badge>{/each}
					<span
						>Updated {formatRelative(base.updatedAt)}{base.createdByName
							? ` · by ${base.createdByName}`
							: ''}</span
					>
					{#if dirty}<Badge variant="warning">Unsaved changes</Badge>{/if}
				</div>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<TimeRangePicker value={range} onchange={setRange} />
				<RefreshPicker
					value={refresh}
					busy={fetching}
					onchange={(next) => (refresh = next)}
					onrefresh={refreshNow}
				/>
				{#if editing}
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button {...props} variant="outline"
									><PlusIcon />Add<ChevronDownIcon class="text-muted-foreground" /></Button
								>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end" class="w-56">
							{#each VIZ.filter((viz) => viz.type !== 'text') as viz (viz.type)}
								<DropdownMenu.Item onSelect={() => addPanel(viz.type)}
									><viz.icon />{viz.label}</DropdownMenu.Item
								>
							{/each}
							<DropdownMenu.Separator />
							<DropdownMenu.Item onSelect={() => addPanel('text')}
								><TypeIcon />Text panel</DropdownMenu.Item
							>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
					<Button
						variant="outline"
						size="icon"
						aria-label="Dashboard settings"
						title="Settings"
						onclick={() => (settingsOpen = true)}
					>
						<Settings2Icon />
					</Button>
					<Button variant="ghost" onclick={discard} disabled={saving}><Undo2Icon />Discard</Button>
					<Button
						onclick={() => save()}
						disabled={saving}
						title="Save (Ctrl/Cmd+S). Also stores the current time range and variable values as defaults."
					>
						{#if saving}<Spinner />{:else}<SaveIcon />{/if}Save
					</Button>
				{:else}
					<Button
						variant="outline"
						size="icon"
						aria-label="Export JSON"
						title="Export JSON"
						onclick={exportJson}><DownloadIcon /></Button
					>
					{#if canEdit}
						<Button variant="outline" onclick={() => (editing = true)}><PencilIcon />Edit</Button>
					{/if}
				{/if}
			</div>
		</header>

		{#if meta.description && !editing}
			<p class="max-w-3xl text-sm text-muted-foreground">{meta.description}</p>
		{/if}

		<TelemetryState {schema} />
		{#if base.usesSql && schema && !schema.canUseSql}
			<Notice tone="info"
				>Some panels use SQL, which only platform admins can run. They show an error for you.</Notice
			>
		{/if}
		{#if conflict}
			<Notice tone="danger" title="Someone else saved this dashboard">
				<p>
					{conflict} Reloading discards your changes; overwriting replaces theirs.
				</p>
				<div class="mt-2 flex gap-2">
					<Button size="sm" variant="outline" onclick={reloadLatest}>Reload theirs</Button>
					<Button size="sm" variant="destructive" onclick={() => save(true)}
						>Overwrite with mine</Button
					>
				</div>
			</Notice>
		{/if}

		<VariablesBar
			variables={spec.variables}
			{values}
			range={resolved}
			names={schema?.names}
			bind:options
			onchange={setVariable}
		/>

		{#if spec.panels.length === 0}
			<EmptyState
				title="This dashboard is empty"
				description="Add a panel to chart a metric, or a text panel for notes."
				icon={LayoutDashboardIcon}
			>
				{#if canEdit}
					<Button onclick={() => addPanel('timeseries')}><PlusIcon />Add panel</Button>
					<Button variant="outline" onclick={() => addPanel('text')}><TypeIcon />Add text</Button>
				{/if}
			</EmptyState>
		{:else}
			<DashboardGrid panels={spec.panels} {editing} onlayout={layoutChanged}>
				{#snippet item(panel)}
					<PanelCard
						{panel}
						range={resolved}
						variables={values}
						names={schema?.names}
						{schema}
						{editing}
						{canEdit}
						onview={() => (viewPanel = panel)}
						onedit={() => {
							editing = true;
							openEditor(panel);
						}}
						oninspect={(result, error) => {
							inspect = { panel, result, error };
							inspectOpen = true;
						}}
						onduplicate={() => duplicate(panel)}
						onremove={() => remove(panel)}
						onzoom={zoom}
					/>
				{/snippet}
			</DashboardGrid>
		{/if}
	</div>

	{#if editorPanel}
		{#key editorPanel.id}
			<PanelEditor
				bind:open={editorOpen}
				panel={editorPanel}
				{schema}
				range={resolved}
				variables={values}
				{variableNames}
				onapply={applyPanel}
			/>
		{/key}
	{/if}

	<DashboardSettings
		bind:open={settingsOpen}
		{meta}
		{spec}
		{schema}
		range={resolved}
		onmeta={(next) => (meta = next)}
		onspec={(next) => (spec = next)}
	/>

	<InspectDialog
		bind:open={inspectOpen}
		panel={inspect?.panel ?? null}
		result={inspect?.result}
		error={inspect?.error ?? null}
		names={schema?.names}
		columnUnits={columnUnits(inspect?.panel.query, schema)}
	/>

	<Dialog.Root open={viewPanel !== null} onOpenChange={(open) => !open && (viewPanel = null)}>
		<Dialog.Content
			class="flex h-[calc(100svh-3rem)] w-[calc(100vw-3rem)] max-w-none flex-col p-3 sm:max-w-none"
		>
			<Dialog.Title class="sr-only">{viewPanel?.title || 'Panel'}</Dialog.Title>
			{#if viewPanel}
				{@const current = spec.panels.find((panel) => panel.id === viewPanel?.id) ?? viewPanel}
				<div class="min-h-0 flex-1 pt-6">
					<PanelCard
						panel={current}
						range={resolved}
						variables={values}
						names={schema?.names}
						fill
						{schema}
						onzoom={zoom}
					/>
				</div>
			{/if}
		</Dialog.Content>
	</Dialog.Root>
{/if}

<ConfirmDialog />

<AlertDialog.Root open={leaving !== null} onOpenChange={(open) => !open && (leaving = null)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Leave without saving?</AlertDialog.Title>
			<AlertDialog.Description
				>This dashboard has unsaved changes. Leaving discards them.</AlertDialog.Description
			>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Stay</AlertDialog.Cancel>
			<Button variant="destructive" onclick={leave}>Discard and leave</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

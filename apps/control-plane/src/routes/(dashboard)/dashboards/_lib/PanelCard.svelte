<script lang="ts">
	/**
	 * One dashboard panel: header (title, status icons, menu), its own query and the
	 * visualisation. In edit mode the header is the drag handle (`data-drag-handle`) the grid
	 * listens for.
	 */
	import type {
		DashboardPanel,
		ObservabilitySchema,
		QueryResult,
		QueryVariables
	} from '@yoal/contracts';
	import BellPlusIcon from '@lucide/svelte/icons/bell-plus';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import EllipsisVerticalIcon from '@lucide/svelte/icons/ellipsis-vertical';
	import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';
	import InfoIcon from '@lucide/svelte/icons/info';
	import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import SearchCodeIcon from '@lucide/svelte/icons/search-code';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { errorText } from '#lib/query.js';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { DRAFT_KEY, draftFromPanel } from '../../alerts/_lib/rules.js';
	import { columnUnits } from './panel.js';
	import { createPanelQuery, referencedVariables } from './panel-query.svelte.js';
	import type { Names } from './series.js';
	import type { ResolvedRange } from './time.js';
	import { interpolate } from './variables.js';
	import PanelViz from './viz/PanelViz.svelte';

	let {
		panel,
		range,
		variables,
		names,
		schema,
		editing = false,
		canEdit = false,
		fill = false,
		onview,
		onedit,
		oninspect,
		onduplicate,
		onremove,
		onzoom
	}: {
		panel: DashboardPanel;
		range: ResolvedRange | null;
		variables: QueryVariables;
		names?: Names;
		/** For per-column table units. */
		schema?: ObservabilitySchema;
		editing?: boolean;
		canEdit?: boolean;
		/** Expanded view: no fixed height from the grid. */
		fill?: boolean;
		onview?: () => void;
		onedit?: () => void;
		oninspect?: (result: QueryResult | undefined, error: string | null) => void;
		onduplicate?: () => void;
		onremove?: () => void;
		onzoom?: (from: number, to: number) => void;
	} = $props();

	let width = $state(0);
	const isText = $derived(panel.viz === 'text');
	const data = createPanelQuery(() => ({
		query: panel.query,
		range,
		width,
		variables,
		enabled: !isText
	}));

	const result = $derived(data.data as QueryResult | undefined);
	const error = $derived(data.error ? errorText(data.error, 'The query failed.') : null);
	const empty = $derived(result !== undefined && result.rows.length === 0);
	const title = $derived(interpolate(panel.title, variables));
	const text = $derived(isText ? interpolate(String(panel.options?.text ?? ''), variables) : '');
	/** "Create alert…": builder panels with a metric, for people who can write alert rules. */
	const canAlert = $derived(
		panel.query?.mode === 'builder' &&
			panel.query.builder.metrics.length > 0 &&
			Boolean(page.params.id) &&
			(page.data.role === 'owner' ||
				page.data.role === 'admin' ||
				page.data.can?.manageNodes === true)
	);

	function createAlert() {
		const draft = draftFromPanel({
			query: panel.query,
			title,
			variables: referencedVariables(panel.query, variables),
			dashboardId: page.params.id ?? '',
			panelId: panel.id
		});
		if (!draft) return;
		sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route plus `?draft`
		void goto(`${resolve('/(dashboard)/alerts/rules/new')}?draft=1`);
	}

	const warning = $derived(
		result?.truncated
			? `Results were cut off at the server's row limit.${result.notice ? ` ${result.notice}` : ''}`
			: (result?.notice ?? null)
	);
</script>

<section
	class="group/panel flex size-full min-h-0 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs {editing
		? 'ring-brand/30 hover:ring-2'
		: ''}"
	aria-label={title || 'Panel'}
	bind:clientWidth={width}
>
	<header
		class="flex h-8 shrink-0 items-center gap-1 px-2 {editing ? 'cursor-move' : ''}"
		data-drag-handle={editing ? '' : undefined}
	>
		{#if editing}
			<GripVerticalIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
		{/if}
		<h2 class="min-w-0 truncate text-sm font-medium" {title}>{title}</h2>
		{#if panel.description}
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<InfoIcon
							{...props}
							class="size-3.5 shrink-0 text-muted-foreground"
							aria-label="Description"
						/>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content class="max-w-xs whitespace-pre-line">{panel.description}</Tooltip.Content>
			</Tooltip.Root>
		{/if}
		{#if warning}
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<TriangleAlertIcon
							{...props}
							class="size-3.5 shrink-0 text-warning"
							aria-label={warning}
						/>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content class="max-w-xs">{warning}</Tooltip.Content>
			</Tooltip.Root>
		{/if}
		{#if error && result}
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<CircleAlertIcon
							{...props}
							class="size-3.5 shrink-0 text-destructive"
							aria-label={error}
						/>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content class="max-w-sm">{error}</Tooltip.Content>
			</Tooltip.Root>
		{/if}
		<span class="ml-auto flex shrink-0 items-center gap-0.5">
			{#if data.isFetching && !isText}
				<Spinner class="size-3 text-muted-foreground" aria-label="Loading" />
			{/if}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon-xs"
							class="opacity-60 group-hover/panel:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
							aria-label="Panel menu for {title || 'panel'}"
							onpointerdown={(event: PointerEvent) => event.stopPropagation()}
						>
							<EllipsisVerticalIcon />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-44">
					{#if onview}
						<DropdownMenu.Item onSelect={onview}><Maximize2Icon />View</DropdownMenu.Item>
					{/if}
					{#if canEdit && onedit}
						<DropdownMenu.Item onSelect={onedit}><PencilIcon />Edit</DropdownMenu.Item>
					{/if}
					{#if !isText && oninspect}
						<DropdownMenu.Item onSelect={() => oninspect?.(result, error)}>
							<SearchCodeIcon />Inspect
						</DropdownMenu.Item>
					{/if}
					{#if canAlert && !isText}
						<DropdownMenu.Item onSelect={createAlert}
							><BellPlusIcon />Create alert…</DropdownMenu.Item
						>
					{/if}
					{#if canEdit && (onduplicate || onremove)}
						<DropdownMenu.Separator />
						{#if onduplicate}
							<DropdownMenu.Item onSelect={onduplicate}><CopyIcon />Duplicate</DropdownMenu.Item>
						{/if}
						{#if onremove}
							<DropdownMenu.Item variant="destructive" onSelect={onremove}
								><Trash2Icon />Remove</DropdownMenu.Item
							>
						{/if}
					{/if}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</span>
	</header>

	<div class="relative min-h-0 flex-1 px-2 pb-2 {fill ? 'min-h-[50vh]' : ''}">
		{#if isText}
			<PanelViz {panel} {range} {text} {names} />
		{:else if schema?.installed === false}
			<p class="grid size-full place-items-center px-3 text-center text-xs text-muted-foreground">
				Telemetry is not installed, so there is no data to show.
			</p>
		{:else if !range}
			<p class="grid size-full place-items-center text-xs text-muted-foreground">
				Invalid time range
			</p>
		{:else if error && !result}
			<div
				class="flex size-full flex-col items-center justify-center gap-1.5 overflow-auto px-3 text-center"
				role="alert"
			>
				<CircleAlertIcon class="size-4 text-destructive" />
				<p class="max-w-md text-xs break-words whitespace-pre-wrap text-destructive">{error}</p>
			</div>
		{:else if !result}
			<Skeleton class="size-full rounded-md" />
		{:else if empty}
			<p class="grid size-full place-items-center text-sm text-muted-foreground">No data</p>
		{:else}
			<PanelViz
				{panel}
				{result}
				{names}
				{range}
				{onzoom}
				columnUnits={columnUnits(panel.query, schema)}
			/>
		{/if}
	</div>
</section>

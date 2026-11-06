<script lang="ts">
	/**
	 * Observability dashboards (D101): the org's saved dashboards, with search and tag filters,
	 * new dashboards (blank or from a starter template), JSON import, duplicate and delete.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		dashboardSpecSchema,
		type DashboardCreateInput,
		type DashboardSummary
	} from '@skiff/contracts';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import ChartAreaIcon from '@lucide/svelte/icons/chart-area';
	import CompassIcon from '@lucide/svelte/icons/compass';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import LayoutTemplateIcon from '@lucide/svelte/icons/layout-template';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import DataTable, { type DataColumn } from '#lib/components/skiff/DataTable.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { errorText } from '#lib/query.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import RowMenu from '../_lib/RowMenu.svelte';
	import { formatRelative } from '../_lib/format.js';
	import {
		createDashboard,
		deleteDashboard,
		getDashboard,
		getSchema,
		keys,
		listDashboards
	} from './_lib/api.js';
	import ConfirmDialog, { confirmAction } from './_lib/ConfirmDialog.svelte';
	import { clone, normalizeSpec } from './_lib/panel.js';
	import { fitTemplate, templates, type DashboardTemplate } from './_lib/templates.js';
	import TelemetryState from './_lib/TelemetryState.svelte';

	const queryClient = useQueryClient();
	const list = createQuery(() => ({
		queryKey: keys.dashboards,
		queryFn: ({ signal }) => listDashboards(signal)
	}));
	const schemaQuery = createQuery(() => ({
		queryKey: keys.schema,
		queryFn: ({ signal }) => getSchema(signal),
		staleTime: 60_000
	}));
	const schema = $derived(schemaQuery.data);
	const dashboards = $derived(list.data ?? []);

	let search = $state('');
	let tag = $state<string | null>(null);
	const allTags = $derived([...new Set(dashboards.flatMap((item) => item.tags))].sort());
	const rows = $derived(tag ? dashboards.filter((item) => item.tags.includes(tag!)) : dashboards);

	const columns: DataColumn<DashboardSummary>[] = [
		{
			id: 'title',
			header: 'Dashboard',
			value: (row) => `${row.title} ${row.description}`,
			cell: titleCell,
			class: 'pl-4'
		},
		{
			id: 'tags',
			header: 'Tags',
			value: (row) => row.tags.join(' '),
			sortable: false,
			cell: tagsCell,
			class: 'hidden md:table-cell'
		},
		{
			id: 'panels',
			header: 'Panels',
			value: (row) => row.panelCount,
			searchable: false,
			descFirst: true,
			cell: panelsCell,
			class: 'hidden font-mono text-xs tabular-nums sm:table-cell'
		},
		{
			id: 'author',
			header: 'Created by',
			value: (row) => row.createdByName ?? '',
			cell: authorCell,
			class: 'hidden text-xs lg:table-cell'
		},
		{
			id: 'updated',
			header: 'Updated',
			value: (row) => row.updatedAt,
			searchable: false,
			descFirst: true,
			cell: updatedCell,
			class: 'text-xs text-muted-foreground'
		},
		{ id: 'actions', header: '', srHeader: 'Actions', cell: actionsCell, class: 'w-0 pr-4' }
	];

	// --- create, import, duplicate, delete ----------------------------------------------------

	let creating = $state(false);
	let newOpen = $state(false);
	let newTitle = $state('');
	let picked = $state<DashboardTemplate | null>(null);
	const starters = templates();

	async function create(input: DashboardCreateInput) {
		creating = true;
		try {
			const view = await createDashboard(input);
			queryClient.setQueryData(keys.dashboard(view.id), view);
			void queryClient.invalidateQueries({ queryKey: keys.dashboards });
			newOpen = false;
			importOpen = false;
			await goto(resolve('/(dashboard)/dashboards/[id]', { id: view.id }));
		} catch (error) {
			toast.error(errorText(error, 'Could not create the dashboard.'));
		} finally {
			creating = false;
		}
	}

	function openNew(template: DashboardTemplate | null) {
		picked = template;
		newTitle = template?.title ?? '';
		newOpen = true;
	}

	function submitNew(event: SubmitEvent) {
		event.preventDefault();
		const title = newTitle.trim() || picked?.title || 'New dashboard';
		void create({
			title,
			description: picked?.description ?? '',
			tags: picked?.tags ?? [],
			spec: picked ? fitTemplate(clone(picked.spec), schema) : normalizeSpec(undefined)
		});
	}

	let importOpen = $state(false);
	let importText = $state('');
	let importError = $state<string | null>(null);

	function submitImport(event: SubmitEvent) {
		event.preventDefault();
		importError = null;
		let raw: Record<string, unknown>;
		try {
			raw = JSON.parse(importText) as Record<string, unknown>;
		} catch (error) {
			importError = error instanceof Error ? error.message : 'Not valid JSON.';
			return;
		}
		const wrapped = raw && typeof raw === 'object' && 'spec' in raw;
		const parsed = dashboardSpecSchema.safeParse(wrapped ? raw.spec : raw);
		if (!parsed.success) {
			importError = parsed.error.issues
				.slice(0, 5)
				.map((issue) => `${issue.path.join('.') || 'spec'}: ${issue.message}`)
				.join('\n');
			return;
		}
		const title =
			typeof raw.title === 'string' && raw.title.trim()
				? raw.title.trim().slice(0, 120)
				: 'Imported dashboard';
		void create({
			title,
			description: typeof raw.description === 'string' ? raw.description.slice(0, 1000) : '',
			tags: Array.isArray(raw.tags)
				? raw.tags.filter((item): item is string => typeof item === 'string').slice(0, 10)
				: [],
			spec: normalizeSpec(parsed.data)
		});
	}

	async function duplicate(row: DashboardSummary) {
		try {
			const full = await getDashboard(row.id);
			await create({
				title: `${full.title} (copy)`.slice(0, 120),
				description: full.description,
				tags: full.tags,
				spec: full.spec
			});
		} catch (error) {
			toast.error(errorText(error, 'Could not duplicate the dashboard.'));
		}
	}

	function remove(row: DashboardSummary) {
		confirmAction({
			title: `Delete “${row.title}”?`,
			description:
				'The dashboard and its panels are deleted for everyone in the organisation. Telemetry data is not affected.',
			confirmLabel: 'Delete dashboard',
			tone: 'danger',
			run: async () => {
				await deleteDashboard(row.id);
				queryClient.setQueryData<DashboardSummary[]>(keys.dashboards, (current) =>
					current?.filter((item) => item.id !== row.id)
				);
				queryClient.removeQueries({ queryKey: keys.dashboard(row.id) });
				toast.success('Dashboard deleted');
			}
		});
	}
</script>

<svelte:head><title>Dashboards · Skiff</title></svelte:head>

{#snippet titleCell(row: DashboardSummary)}
	<a
		href={resolve('/(dashboard)/dashboards/[id]', { id: row.id })}
		class="group/link block min-w-0"
	>
		<span class="font-medium group-hover/link:underline">{row.title}</span>
		{#if row.usesSql}<Badge variant="neutral" class="ml-1.5 align-middle">SQL</Badge>{/if}
		{#if row.description}<span class="block max-w-xl truncate text-xs text-muted-foreground"
				>{row.description}</span
			>{/if}
	</a>
{/snippet}
{#snippet tagsCell(row: DashboardSummary)}
	<span class="flex flex-wrap gap-1">
		{#each row.tags as item (item)}
			<button
				type="button"
				class="rounded-full"
				onclick={() => (tag = item)}
				aria-label="Filter by tag {item}"
			>
				<Badge variant={tag === item ? 'brand' : 'secondary'}>{item}</Badge>
			</button>
		{/each}
	</span>
{/snippet}
{#snippet panelsCell(row: DashboardSummary)}{row.panelCount}{/snippet}
{#snippet authorCell(row: DashboardSummary)}{row.createdByName ?? '—'}{/snippet}
{#snippet updatedCell(row: DashboardSummary)}<span title={row.updatedAt}
		>{formatRelative(row.updatedAt)}</span
	>{/snippet}
{#snippet actionsCell(row: DashboardSummary)}
	<RowMenu label="Actions for {row.title}">
		<DropdownMenu.Item onSelect={() => duplicate(row)}><CopyIcon />Duplicate</DropdownMenu.Item>
		{#if row.canEdit}
			<DropdownMenu.Separator />
			<DropdownMenu.Item variant="destructive" onSelect={() => remove(row)}
				><Trash2Icon />Delete</DropdownMenu.Item
			>
		{/if}
	</RowMenu>
{/snippet}

<div class="space-y-6">
	<PageHeader
		title="Dashboards"
		description="Build your own charts over traffic, database and storage telemetry. Panels query the ClickHouse store; templates give you a head start."
	>
		<Button variant="outline" href={resolve('/(dashboard)/dashboards/explore')}
			><CompassIcon />Explore</Button
		>
		<Button variant="outline" onclick={() => ((importOpen = true), (importError = null))}
			><UploadIcon />Import</Button
		>
		<Button onclick={() => openNew(null)}><PlusIcon />New dashboard</Button>
	</PageHeader>

	<TelemetryState {schema} />

	<section class="space-y-3" aria-labelledby="starters">
		<h2 id="starters" class="text-sm font-medium text-muted-foreground">Start from a template</h2>
		<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
			{#each starters as template (template.id)}
				<button type="button" class="text-left" onclick={() => openNew(template)}>
					<Card.Root
						class="h-full gap-2 py-4 transition-colors hover:border-brand/50 hover:bg-muted/30"
					>
						<Card.Header class="px-4">
							<Card.Title class="flex items-center gap-2 text-sm"
								><LayoutTemplateIcon class="size-4 text-brand" />{template.title}</Card.Title
							>
							<Card.Description class="text-xs">{template.description}</Card.Description>
						</Card.Header>
						<Card.Content class="px-4 text-xs text-muted-foreground"
							>{template.spec.panels.length} panels</Card.Content
						>
					</Card.Root>
				</button>
			{/each}
			<button type="button" class="text-left" onclick={() => openNew(null)}>
				<Card.Root
					class="h-full gap-2 border-dashed py-4 transition-colors hover:border-brand/50 hover:bg-muted/30"
				>
					<Card.Header class="px-4">
						<Card.Title class="flex items-center gap-2 text-sm"
							><PlusIcon class="size-4 text-muted-foreground" />Blank dashboard</Card.Title
						>
						<Card.Description class="text-xs"
							>An empty grid: add panels with the query builder{schema?.canUseSql
								? ' or SQL'
								: ''}.</Card.Description
						>
					</Card.Header>
				</Card.Root>
			</button>
		</div>
	</section>

	<section class="space-y-3" aria-labelledby="saved">
		<div class="flex flex-wrap items-center gap-2">
			<h2 id="saved" class="mr-auto text-sm font-medium text-muted-foreground">Saved dashboards</h2>
			{#if allTags.length > 0}
				<div class="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by tag">
					<button type="button" onclick={() => (tag = null)}
						><Badge variant={tag === null ? 'brand' : 'outline'}>All</Badge></button
					>
					{#each allTags as item (item)}
						<button type="button" onclick={() => (tag = tag === item ? null : item)}
							><Badge variant={tag === item ? 'brand' : 'outline'}>{item}</Badge></button
						>
					{/each}
				</div>
			{/if}
			<InputGroup.Root class="w-full sm:w-64">
				<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
				<InputGroup.Input
					bind:value={search}
					placeholder="Search dashboards"
					aria-label="Search dashboards"
				/>
			</InputGroup.Root>
		</div>

		{#if list.isPending}
			<div class="space-y-2">
				<Skeleton class="h-12" /><Skeleton class="h-12" /><Skeleton class="h-12" />
			</div>
		{:else if list.error}
			<Notice tone="danger" title="Could not load dashboards">{errorText(list.error)}</Notice>
		{:else if dashboards.length === 0}
			<EmptyState
				title="No dashboards yet"
				description="Create one from a template above, start blank, or import a JSON export."
				icon={ChartAreaIcon}
			>
				<Button onclick={() => openNew(starters[0]!)}><LayoutTemplateIcon />Traffic overview</Button
				>
				<Button variant="outline" onclick={() => openNew(null)}><PlusIcon />Blank</Button>
			</EmptyState>
		{:else}
			<Card.Root class="py-0">
				<DataTable
					{rows}
					{columns}
					rowId={(row) => row.id}
					{search}
					sort={{ id: 'updated', desc: true }}
					label="Dashboards"
				/>
			</Card.Root>
		{/if}
	</section>
</div>

<Dialog.Root bind:open={newOpen}>
	<Dialog.Content>
		<form class="contents" onsubmit={submitNew}>
			<Dialog.Header>
				<Dialog.Title>{picked ? `New from “${picked.title}”` : 'New dashboard'}</Dialog.Title>
				<Dialog.Description>
					{picked
						? `${picked.description} Panels for fields this server does not have are left out.`
						: 'Starts empty; add panels after it is created.'}
				</Dialog.Description>
			</Dialog.Header>
			<label class="block space-y-1.5">
				<span class="text-sm font-medium">Title</span>
				<Input bind:value={newTitle} maxlength={120} placeholder="My dashboard" required />
			</label>
			<Dialog.Footer>
				<Dialog.Close
					>{#snippet child({ props })}<Button {...props} variant="outline">Cancel</Button
						>{/snippet}</Dialog.Close
				>
				<Button type="submit" disabled={creating}
					>{#if creating}<Spinner />{/if}Create</Button
				>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={importOpen}>
	<Dialog.Content class="sm:max-w-2xl">
		<form class="contents" onsubmit={submitImport}>
			<Dialog.Header>
				<Dialog.Title>Import dashboard</Dialog.Title>
				<Dialog.Description
					>Paste a dashboard export (with <code class="font-mono">title</code> and
					<code class="font-mono">spec</code>) or a bare spec.</Dialog.Description
				>
			</Dialog.Header>
			<Textarea
				bind:value={importText}
				class="min-h-64 font-mono text-xs"
				placeholder={'{ "title": "…", "spec": { "panels": [] } }'}
				aria-label="Dashboard JSON"
			/>
			{#if importError}<pre
					class="text-xs whitespace-pre-wrap text-destructive"
					role="alert">{importError}</pre>{/if}
			<Dialog.Footer>
				<Dialog.Close
					>{#snippet child({ props })}<Button {...props} variant="outline">Cancel</Button
						>{/snippet}</Dialog.Close
				>
				<Button type="submit" disabled={creating || !importText.trim()}
					>{#if creating}<Spinner />{/if}Import</Button
				>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog />

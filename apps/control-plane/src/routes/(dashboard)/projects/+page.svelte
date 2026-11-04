<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onDestroy, onMount, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import BoxesIcon from '@lucide/svelte/icons/boxes';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { operationActions, operationLimits, type OperationActionInfo } from '@skiff/contracts';
	import { toast } from 'svelte-sonner';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import AccessChip from '../_lib/AccessChip.svelte';
	import AccessSelect from '../_lib/AccessSelect.svelte';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import ProjectMark from '../_lib/ProjectMark.svelte';
	import RowMenu from '../_lib/RowMenu.svelte';
	import { formatDate } from '../_lib/format.js';
	import BulkBar from '../_lib/operations/BulkBar.svelte';
	import BulkConfirmDialog from '../_lib/operations/BulkConfirmDialog.svelte';
	import BulkProgress from '../_lib/operations/BulkProgress.svelte';
	import { BulkController } from '../_lib/operations/bulk.svelte.js';
	import { purgeCountdown } from '../_lib/operations/copy.js';
	import type { PageProps } from './$types';

	interface ProjectFormResult {
		message?: string;
		suggestions?: string[];
		fieldErrors?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as ProjectFormResult | null);

	let createOpen = $state(page.url.searchParams.get('new') === '1');
	let query = $state('');
	let slug = $state('');
	let runtime = $state('static');
	let placement = $state('edge');
	let productionAccess = $state('public');
	let previewAccess = $state('platform');

	// Static releases are always served by the edge (`placement.ts` resolves them there).
	$effect(() => {
		if (runtime === 'static') placement = 'edge';
	});

	const placementChoices = $derived([
		{ value: 'edge', label: 'Edge node' },
		{ value: 'auto', label: 'Auto — most free slice budget' },
		...data.capacity
			.filter((item) => item.mode !== 'edge')
			.map((item) => ({ value: item.nodeId, label: `${item.name} (${item.mode})` }))
	]);

	const trashView = $derived(data.view === 'trash');
	const rows = $derived(trashView ? data.trash : data.projects);
	const filtered = $derived(
		rows.filter((project) => {
			const q = query.trim().toLowerCase();
			return !q || project.name.toLowerCase().includes(q) || project.slug.includes(q);
		})
	);

	// --- selection and bulk actions (docs/OPERATIONS.md §6.4) --------------------------------

	const LIMIT = operationLimits.bulkTargets;

	/** `?select=a,b,c` preselects rows (MCP hands legacy clients a link like that). */
	const selected = new SvelteSet<string>(
		untrack(() => {
			const wanted = (page.url.searchParams.get('select') ?? '')
				.split(',')
				.map((value) => value.trim())
				.filter(Boolean);
			const known = new Set(rows.map((project) => project.slug));
			return wanted.filter((value) => known.has(value)).slice(0, LIMIT);
		})
	);
	let anchor = $state<number | null>(null);
	let capped = $state(false);
	let shiftHeld = false;

	const selectedRows = $derived(rows.filter((project) => selected.has(project.slug)));
	const selectable = $derived(filtered.slice(0, LIMIT));
	const allSelected = $derived(
		selectable.length > 0 && selectable.every((project) => selected.has(project.slug))
	);
	const someSelected = $derived(
		!allSelected && filtered.some((project) => selected.has(project.slug))
	);

	function clearSelection() {
		selected.clear();
		anchor = null;
		capped = false;
	}

	function add(value: string): boolean {
		if (selected.has(value)) return true;
		if (selected.size >= LIMIT) {
			capped = true;
			return false;
		}
		selected.add(value);
		return true;
	}

	function toggleAll(value: boolean) {
		if (!value || allSelected) return clearSelection();
		selected.clear();
		for (const project of selectable) selected.add(project.slug);
		capped = filtered.length > LIMIT;
		anchor = null;
	}

	function toggleRow(index: number, value: boolean) {
		const range =
			shiftHeld && anchor !== null && anchor !== index
				? filtered.slice(Math.min(anchor, index), Math.max(anchor, index) + 1)
				: [filtered[index]];
		for (const project of range) {
			if (!project) continue;
			if (value) {
				if (!add(project.slug)) break;
			} else selected.delete(project.slug);
		}
		if (!value) capped = false;
		anchor = index;
		shiftHeld = false;
	}

	// Selection belongs to one list and one search.
	let lastView = untrack(() => data.view);
	$effect(() => {
		if (data.view === lastView) return;
		lastView = data.view;
		query = '';
		untrack(clearSelection);
	});

	const viewActions = $derived(
		data.actions.filter((action) => action.appliesTo === (trashView ? 'trash' : 'projects'))
	);
	const primaryIds = $derived(
		trashView ? ['project.restore', 'project.purge'] : ['project.delete']
	);
	const primaryActions = $derived(viewActions.filter((action) => primaryIds.includes(action.id)));
	const moreActions = $derived(viewActions.filter((action) => !primaryIds.includes(action.id)));
	const purgeInfo = $derived(data.actions.find((action) => action.id === 'project.purge'));
	/** Checkboxes only make sense when the viewer can run something on this list. */
	const selecting = $derived(viewActions.length > 0);

	const detailHref = (id: string) =>
		resolve('/(dashboard)/settings/maintenance/operations/[id]', { id });

	const bulk = new BulkController({
		canUndo: () => data.actions.some((action) => action.id === 'project.restore'),
		onSettled: () => invalidateAll(),
		detailHref,
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- hrefs come from detailHref (resolved)
		navigate: (href) => void goto(href),
		onApplied: clearSelection
	});

	onMount(() => {
		const active = data.activeBulk;
		if (active) bulk.follow(operationActions[active.action], active);
	});
	onDestroy(() => bulk.destroy());

	function runBulk(info: OperationActionInfo, slugs = selectedRows.map((project) => project.slug)) {
		void bulk.start(info, slugs);
	}

	// --- row helpers ---------------------------------------------------------------------------

	function runtimeIcon(value: string) {
		return value === 'container' ? BoxesIcon : value === 'process' ? CpuIcon : LayersIcon;
	}

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		toast.success('Copied to the clipboard.');
	}

	function confirmDelete(project: { name: string; slug: string }) {
		askConfirm({
			title: `Delete ${project.name}?`,
			description: `The project moves to the trash and is kept for 7 days. ${project.slug}.${data.contentDomain} stops serving.`,
			confirmLabel: 'Move to trash',
			tone: 'danger',
			action: '?/delete',
			fields: { slug: project.slug }
		});
	}

	function restoreOne(project: { slug: string }) {
		void runAction('?/restore', { slug: project.slug });
	}

	function setView(value: string) {
		const href = resolve('/(dashboard)/projects');
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route, only `?view` changes
		void goto(value === 'trash' ? `${href}?view=trash` : href);
	}
</script>

<svelte:head>
	<title>{trashView ? 'Trash' : 'Projects'} · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		eyebrow="Operate"
		title="Projects"
		description="A project owns one global slug, its deployments, environments and production pointer. Projects can serve static files, run a process app, or run a container."
	>
		{#if data.can.createProject}
			<Button onclick={() => (createOpen = true)}>
				<PlusIcon />
				New project
			</Button>
		{/if}
	</PageHeader>

	<Tabs.Root value={data.view} onValueChange={setView}>
		<Tabs.List variant="line" class="w-full justify-start border-b" aria-label="Project lists">
			<Tabs.Trigger value="projects" class="flex-none">
				<FolderKanbanIcon />
				Projects
				<span class="font-mono text-xs text-muted-foreground">{data.projects.length}</span>
			</Tabs.Trigger>
			<Tabs.Trigger value="trash" class="flex-none">
				<Trash2Icon />
				Trash
				<span class="font-mono text-xs text-muted-foreground">{data.trash.length}</span>
			</Tabs.Trigger>
		</Tabs.List>
	</Tabs.Root>

	{#if rows.length === 0}
		{#if trashView}
			<EmptyState
				icon={Trash2Icon}
				title="The trash is empty"
				description="Deleted projects stay here for 7 days, then they are permanently deleted."
			/>
		{:else}
			<EmptyState
				icon={FolderKanbanIcon}
				title="No projects yet"
				description="Create one here, or ask your agent to deploy a site — the first deploy creates the project automatically."
			>
				{#if data.can.createProject}
					<Button onclick={() => (createOpen = true)}><PlusIcon />Create a project</Button>
				{/if}
			</EmptyState>
		{/if}
	{:else}
		<div class="flex flex-wrap items-center justify-between gap-3">
			<InputGroup.Root class="max-w-xs bg-card">
				<InputGroup.Input
					placeholder={trashView ? 'Search the trash' : 'Search projects'}
					bind:value={query}
					oninput={clearSelection}
					aria-label={trashView ? 'Search the trash' : 'Search projects'}
				/>
				<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
				{#if query}
					<InputGroup.Addon align="inline-end">
						<InputGroup.Text class="font-mono text-xs">{filtered.length}</InputGroup.Text>
					</InputGroup.Addon>
				{/if}
			</InputGroup.Root>
			<p class="text-sm text-muted-foreground">
				{#if trashView}
					{rows.length} in the trash · purged after 7 days
				{:else}
					{rows.length}
					{rows.length === 1 ? 'project' : 'projects'} in {data.org.name}
				{/if}
			</p>
		</div>

		<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						{#if selecting}
							<Table.Head class="w-0 pr-0 pl-4">
								<Checkbox
									bind:checked={() => allSelected, toggleAll}
									bind:indeterminate={() => someSelected, () => {}}
									disabled={filtered.length === 0}
									aria-label={filtered.length > LIMIT
										? `Select the first ${LIMIT} projects`
										: 'Select all projects'}
								/>
							</Table.Head>
						{/if}
						<Table.Head class={selecting ? '' : 'pl-4'}>Project</Table.Head>
						{#if trashView}
							<Table.Head class="hidden sm:table-cell">Deleted</Table.Head>
							<Table.Head>Purge</Table.Head>
						{:else}
							<Table.Head class="hidden md:table-cell">Runtime</Table.Head>
							<Table.Head class="hidden md:table-cell">Production</Table.Head>
							<Table.Head class="hidden lg:table-cell">Access</Table.Head>
							<Table.Head class="hidden sm:table-cell">Created</Table.Head>
						{/if}
						<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each filtered as project, index (project.slug)}
						{@const href = resolve('/(dashboard)/projects/[slug]', { slug: project.slug })}
						{@const checked = selected.has(project.slug)}
						<Table.Row class="group" data-state={checked ? 'selected' : undefined}>
							{#if selecting}
								<Table.Cell class="pr-0 pl-4">
									<Checkbox
										bind:checked={() => checked, (value) => toggleRow(index, value)}
										onclick={(event: MouseEvent) => (shiftHeld = event.shiftKey)}
										onmousedown={(event: MouseEvent) => event.shiftKey && event.preventDefault()}
										aria-label="Select {project.name}"
									/>
								</Table.Cell>
							{/if}
							<Table.Cell class={selecting ? '' : 'pl-4'}>
								<div class="flex items-center gap-3">
									<ProjectMark slug={project.slug} name={project.name} />
									<div class="min-w-0">
										{#if trashView}
											<span class="font-medium">{project.name}</span>
										{:else}
											<a {href} class="font-medium underline-offset-4 group-hover:underline"
												>{project.name}</a
											>
										{/if}
										<p class="truncate font-mono text-xs text-muted-foreground">
											{project.slug}.{data.contentDomain}
										</p>
									</div>
								</div>
							</Table.Cell>
							{#if trashView}
								<Table.Cell class="hidden font-mono text-xs text-muted-foreground sm:table-cell">
									<time datetime={project.deletedAt}>{formatDate(project.deletedAt)}</time>
								</Table.Cell>
								<Table.Cell class="text-xs text-muted-foreground">
									<time datetime={project.purgeAt}>{purgeCountdown(project.purgeAt)}</time>
								</Table.Cell>
							{:else}
								<Table.Cell class="hidden md:table-cell">
									{@const Icon = runtimeIcon(project.runtime)}
									<span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
										<Icon class="size-3.5" />
										<span class="capitalize">{project.runtime}</span>
									</span>
									<p class="font-mono text-xs text-muted-foreground">{project.placement}</p>
								</Table.Cell>
								<Table.Cell class="hidden md:table-cell">
									{#if project.productionDeploymentId}
										<StatusBadge status="online" tone="success" label="Live" />
									{:else}
										<StatusBadge status="inactive" label="Not deployed" />
									{/if}
								</Table.Cell>
								<Table.Cell class="hidden lg:table-cell">
									<div class="flex flex-wrap gap-1.5">
										<AccessChip scope="Prod" mode={project.productionAccess} />
										<AccessChip scope="Preview" mode={project.previewAccess} />
									</div>
								</Table.Cell>
								<Table.Cell class="hidden font-mono text-xs text-muted-foreground sm:table-cell">
									<time datetime={project.createdAt}>{formatDate(project.createdAt)}</time>
								</Table.Cell>
							{/if}
							<Table.Cell class="pr-4">
								{#if trashView}
									{#if data.can.updateProject || purgeInfo}
										<RowMenu label="Actions for {project.name}">
											{#if data.can.updateProject}
												<DropdownMenu.Item onSelect={() => restoreOne(project)}>
													<RotateCcwIcon />Restore
												</DropdownMenu.Item>
											{/if}
											{#if purgeInfo}
												<DropdownMenu.Separator />
												<DropdownMenu.Item
													variant="destructive"
													disabled={bulk.busy}
													onSelect={() => runBulk(purgeInfo, [project.slug])}
												>
													<TrashIcon />Delete permanently
												</DropdownMenu.Item>
											{/if}
										</RowMenu>
									{/if}
								{:else}
									<RowMenu label="Actions for {project.name}">
										<DropdownMenu.Item onSelect={() => goto(href)}>
											<ArrowRightIcon />Open project
										</DropdownMenu.Item>
										<DropdownMenu.Item
											onSelect={() => window.open(project.productionUrl, '_blank', 'noreferrer')}
										>
											<ArrowUpRightIcon />Visit site
										</DropdownMenu.Item>
										<DropdownMenu.Item onSelect={() => copy(project.productionUrl)}>
											<CopyIcon />Copy URL
										</DropdownMenu.Item>
										{#if data.can.deleteProject}
											<DropdownMenu.Separator />
											<DropdownMenu.Item
												variant="destructive"
												onSelect={() => confirmDelete(project)}
											>
												<TrashIcon />Delete project
											</DropdownMenu.Item>
										{/if}
									</RowMenu>
								{/if}
							</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row>
							<Table.Cell colspan={7} class="py-10 text-center text-sm text-muted-foreground">
								No projects match “{query}”.
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}

	{#if bulk.run}
		<BulkProgress run={bulk.run} href={detailHref(bulk.run.operation.id)} />
	{:else if selectedRows.length > 0}
		<div class="sticky bottom-4 z-20 space-y-1.5">
			<BulkBar
				count={selectedRows.length}
				primary={primaryActions}
				more={moreActions}
				planning={bulk.planning}
				disabled={bulk.plan !== null}
				onrun={(info) => runBulk(info)}
				onclear={clearSelection}
			/>
			{#if capped}
				<p class="text-center text-xs text-muted-foreground">
					Bulk actions run on up to {LIMIT} projects at a time, so only the first {LIMIT} are selected.
				</p>
			{/if}
		</div>
	{/if}
</div>

<BulkConfirmDialog controller={bulk} contentDomain={data.contentDomain} />

{#if data.can.createProject}
	<FormDialog
		bind:open={createOpen}
		icon={FolderKanbanIcon}
		title="New project"
		description="Production defaults to public; previews to platform login. You can change both later."
		action="?/create"
		submitLabel="Create project"
	>
		<Field.Group>
			<Field.Field data-invalid={result?.fieldErrors?.name ? true : undefined}>
				<Field.Label for="project-name">Name</Field.Label>
				<Input
					id="project-name"
					name="name"
					placeholder="Marketing site"
					maxlength={120}
					required
					aria-invalid={result?.fieldErrors?.name ? 'true' : undefined}
				/>
				{#if result?.fieldErrors?.name}<Field.Error>{result.fieldErrors.name}</Field.Error>{/if}
			</Field.Field>

			<Field.Field data-invalid={result?.fieldErrors?.slug ? true : undefined}>
				<Field.Label for="project-slug">
					Slug <span class="font-normal text-muted-foreground">optional</span>
				</Field.Label>
				<InputGroup.Root>
					<InputGroup.Input
						id="project-slug"
						name="slug"
						bind:value={slug}
						placeholder="marketing-site"
						maxlength={40}
						autocapitalize="off"
						spellcheck="false"
						class="font-mono text-sm"
						aria-invalid={result?.fieldErrors?.slug ? 'true' : undefined}
					/>
					<InputGroup.Addon align="inline-end">
						<InputGroup.Text class="font-mono text-xs">.{data.contentDomain}</InputGroup.Text>
					</InputGroup.Addon>
				</InputGroup.Root>
				<Field.Description
					>Leave blank to derive it from the name. Slugs are globally unique.</Field.Description
				>
				{#if result?.fieldErrors?.slug}<Field.Error>{result.fieldErrors.slug}</Field.Error>{/if}
				{#if result?.suggestions?.length}
					<div class="flex flex-wrap items-center gap-1.5">
						<span class="text-xs text-muted-foreground">Try:</span>
						{#each result.suggestions as suggestion (suggestion)}
							<Button
								type="button"
								variant="outline"
								size="xs"
								class="font-mono"
								onclick={() => (slug = suggestion)}>{suggestion}</Button
							>
						{/each}
					</div>
				{/if}
			</Field.Field>

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="project-runtime">Runtime</Field.Label>
					<NativeSelect.Root
						id="project-runtime"
						name="runtime"
						bind:value={runtime}
						class="w-full"
					>
						<NativeSelect.Option value="static">Static files</NativeSelect.Option>
						<NativeSelect.Option value="process">Process app (Bun/Node)</NativeSelect.Option>
						<NativeSelect.Option value="container">Container image</NativeSelect.Option>
					</NativeSelect.Root>
					<Field.Description>
						{runtime === 'static'
							? 'Served by Caddy from an immutable release.'
							: runtime === 'process'
								? 'Runs a command from the release in a sandboxed systemd unit.'
								: 'Runs an OCI image in a rootless container.'}
					</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="project-placement">Placement</Field.Label>
					<NativeSelect.Root
						id="project-placement"
						name="placement"
						bind:value={placement}
						class="w-full"
						disabled={runtime === 'static'}
					>
						{#each placementChoices as option (option.value)}
							<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
					<Field.Description>
						{runtime === 'static'
							? 'Static projects are served by the edge.'
							: 'Admission is checked against the workload slice at deploy time.'}
					</Field.Description>
				</Field.Field>
			</div>
			{#if runtime !== 'static'}
				<Field.Description>
					After creating the project, set the {runtime === 'process' ? 'command' : 'image'}, port
					and memory budget on the project's Runtime tab before the first deploy.
				</Field.Description>
			{/if}

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="production-access">Production access</Field.Label>
					<AccessSelect
						id="production-access"
						name="productionAccess"
						bind:value={productionAccess}
						invalid={Boolean(result?.fieldErrors?.productionAccess)}
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="preview-access">Preview access</Field.Label>
					<AccessSelect
						id="preview-access"
						name="previewAccess"
						bind:value={previewAccess}
						invalid={Boolean(result?.fieldErrors?.previewAccess)}
					/>
				</Field.Field>
			</div>
			{#if productionAccess === 'password' || previewAccess === 'password'}
				<Field.Description>
					Set the project password from the project's Settings tab after it is created.
				</Field.Description>
			{/if}
		</Field.Group>
	</FormDialog>
{/if}

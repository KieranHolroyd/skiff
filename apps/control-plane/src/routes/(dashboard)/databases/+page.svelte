<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import CloudUploadIcon from '@lucide/svelte/icons/cloud-upload';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import DataTable, { type DataColumn } from '#lib/components/skiff/DataTable.svelte';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import RowMenu from '../_lib/RowMenu.svelte';
	import { formatDate } from '../_lib/format.js';
	import { purgeCountdown } from '../_lib/operations/copy.js';
	import StorageMeter from './_lib/StorageMeter.svelte';
	import { databaseEngines } from '@skiff/contracts';
	import type { PageProps } from './$types';

	interface CreateFormResult {
		message?: string;
		fieldErrors?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as CreateFormResult | null);
	const errors = $derived(result?.fieldErrors ?? {});

	const preselectedProject = page.url.searchParams.get('project') ?? '';
	let createOpen = $state(page.url.searchParams.get('new') === '1' || preselectedProject !== '');
	let query = $state('');
	let attachProject = $state(preselectedProject);
	let envPrefix = $state('');
	const requestedEngine = page.url.searchParams.get('engine');
	let engineId = $state<string>(
		(databaseEngines as readonly string[]).includes(requestedEngine ?? '') ? requestedEngine! : 'postgres'
	);
	const engine = $derived(data.engines.find((item) => item.engine === engineId) ?? data.engines[0]!);
	const familyLabel: Record<string, string> = {
		relational: 'SQL',
		document: 'Document',
		'key-value': 'Key-value'
	};

	const trashView = $derived(data.view === 'trash');
	const rows = $derived(trashView ? data.trash : data.databases);
	let matched = $state(0);

	type Row = PageProps['data']['databases'][number];
	const nodeOf = (row: Row) => row.nodeName ?? row.nodeId;
	const nameColumn: DataColumn<Row> = {
		id: 'name',
		header: 'Database',
		value: (row) => row.name,
		cell: nameCell,
		class: 'pl-4'
	};
	const actionsColumn: DataColumn<Row> = {
		id: 'actions',
		header: '',
		srHeader: 'Actions',
		cell: actionsCell,
		class: 'w-0 pr-4'
	};
	const activeColumns: DataColumn<Row>[] = [
		nameColumn,
		{ id: 'status', header: 'Status', value: (row) => row.status, cell: statusCell },
		{
			id: 'node',
			header: 'Node',
			value: nodeOf,
			cell: nodeCell,
			class: 'hidden font-mono text-xs md:table-cell'
		},
		{
			id: 'storage',
			header: 'Storage',
			value: (row) => row.sizeBytes,
			searchable: false,
			descFirst: true,
			cell: storageCell,
			class: 'hidden w-48 lg:table-cell'
		},
		{
			id: 'memory',
			header: 'Memory',
			value: (row) => row.memoryMb,
			searchable: false,
			descFirst: true,
			cell: memoryCell,
			class: 'hidden font-mono text-xs tabular-nums md:table-cell'
		},
		{
			id: 'attached',
			header: 'Attached to',
			// Searchable by project, not sortable: a list of projects has no natural order.
			value: (row) => row.attachments.map((item) => item.projectSlug).join(' '),
			sortable: false,
			cell: attachedCell,
			class: 'hidden lg:table-cell'
		},
		actionsColumn
	];
	const trashColumns: DataColumn<Row>[] = [
		nameColumn,
		{
			id: 'node',
			header: 'Node',
			value: nodeOf,
			cell: nodeCell,
			class: 'hidden font-mono text-xs text-muted-foreground sm:table-cell'
		},
		{
			id: 'deleted',
			header: 'Deleted',
			value: (row) => row.deletedAt,
			searchable: false,
			descFirst: true,
			cell: deletedCell,
			class: 'hidden font-mono text-xs text-muted-foreground sm:table-cell'
		},
		{
			id: 'purge',
			header: 'Purge',
			value: (row) => row.purgeAt,
			searchable: false,
			cell: purgeCell,
			class: 'text-xs text-muted-foreground'
		},
		actionsColumn
	];

	const placementChoices = $derived([
		{ value: 'auto', label: 'Auto — most free slice budget' },
		{ value: 'edge', label: 'Edge node' },
		...data.capacity
			.filter((item) => item.mode !== 'edge')
			.map((item) => ({
				value: item.nodeId,
				label: `${item.name} (${item.freeMemoryMb} MB free)`
			}))
	]);

	function setView(value: string) {
		const href = resolve('/(dashboard)/databases');
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route, only `?view` changes
		void goto(value === 'trash' ? `${href}?view=trash` : href);
	}

	/** Open a detail page on one of its sections. */
	function openSection(href: string, tab: string) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route plus `?tab`
		void goto(`${href}?tab=${tab}`);
	}

	function restore(name: string) {
		void runAction('?/restore', { name });
	}

	function restartOne(name: string) {
		askConfirm({
			title: `Restart ${name}?`,
			description:
				'The database container and its pooler restart. Attached apps lose their connections briefly and reconnect; data and credentials are kept.',
			confirmLabel: 'Restart',
			tone: 'danger',
			action: '?/restart',
			fields: { name }
		});
	}

	function restartAll(scope: 'databases' | 'all') {
		askConfirm({
			title: scope === 'all' ? 'Restart all services?' : 'Restart all databases?',
			description:
				scope === 'all'
					? 'Every managed database and storage instance restarts. Apps lose their connections briefly and reconnect; data and credentials are kept.'
					: 'Every managed database restarts, including its pooler. Apps lose their connections briefly and reconnect; data and credentials are kept.',
			confirmLabel: 'Restart all',
			tone: 'danger',
			action: scope === 'all' ? '?/restart-all-services' : '?/restart-all'
		});
	}

	function backupAll() {
		askConfirm({
			title: 'Back up all databases?',
			description:
				'Queues a logical backup for every database that is not already backing up. Dumps stream to the platform object store.',
			confirmLabel: 'Back up all',
			tone: 'default',
			action: '?/backup-all'
		});
	}

	function purge(name: string) {
		askConfirm({
			title: `Delete ${name} permanently?`,
			description:
				'Its node deletes the data directory and the database is gone for good. This cannot be undone.',
			confirmLabel: 'Delete permanently',
			tone: 'danger',
			typeToConfirm: name,
			action: '?/purge',
			fields: { name }
		});
	}
</script>

<svelte:head>
	<title>{trashView ? 'Database trash' : 'Databases'} · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		target="page.databases"
		eyebrow="Operate"
		title="Databases"
		description="Managed PostgreSQL, MySQL, MariaDB, MongoDB, Valkey and Redis that run next to your apps. Attach a database to a process or container project and it receives a connection URL at start-up."
	>
		{#if data.dbCan.update && !trashView && data.databases.length > 0}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="outline">
							Bulk actions
							<ChevronDownIcon />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-60">
					<DropdownMenu.Item onSelect={backupAll}>
						<CloudUploadIcon />Back up all databases
					</DropdownMenu.Item>
					<DropdownMenu.Item onSelect={() => restartAll('databases')}>
						<RotateCcwIcon />Restart all databases
					</DropdownMenu.Item>
					<DropdownMenu.Separator />
					<DropdownMenu.Item onSelect={() => restartAll('all')}>
						<RotateCcwIcon />Restart all services
						<span class="ml-auto text-xs text-muted-foreground">+ storage</span>
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/if}
		{#if data.dbCan.create}
			<Button onclick={() => (createOpen = true)}>
				<PlusIcon />
				New database
			</Button>
		{/if}
	</PageHeader>

	{#if data.denied}
		<EmptyState
			icon={ShieldAlertIcon}
			title="Databases are not visible"
			description="This account does not have the database:read permission."
		/>
	{:else}
		<Tabs.Root value={data.view} onValueChange={setView}>
			<Tabs.List variant="line" class="w-full justify-start border-b" aria-label="Database lists">
				<Tabs.Trigger value="live" class="flex-none">
					<DatabaseIcon />
					Databases
					<span class="font-mono text-xs text-muted-foreground">{data.databases.length}</span>
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
					description="Deleted databases stay here for 7 days with their data intact, then they are permanently deleted."
				/>
			{:else}
				<EmptyState
					icon={DatabaseIcon}
					title="No databases yet"
					description="Create a database (PostgreSQL, MySQL, MariaDB, MongoDB, Valkey or Redis), then attach it to a project. Apps get connection details as environment variables; the database only listens on its own node."
				>
					{#if data.dbCan.create}
						<Button onclick={() => (createOpen = true)}><PlusIcon />Create a database</Button>
					{/if}
				</EmptyState>
			{/if}
		{:else}
			<div class="flex flex-wrap items-center justify-between gap-3">
				<InputGroup.Root class="max-w-xs bg-card">
					<InputGroup.Input
						placeholder={trashView ? 'Search the trash' : 'Search databases'}
						bind:value={query}
						aria-label={trashView ? 'Search the trash' : 'Search databases'}
					/>
					<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
					{#if query}
						<InputGroup.Addon align="inline-end">
							<InputGroup.Text class="font-mono text-xs">{matched}</InputGroup.Text>
						</InputGroup.Addon>
					{/if}
				</InputGroup.Root>
				<p class="text-sm text-muted-foreground">
					{#if trashView}
						{rows.length} in the trash · purged after 7 days
					{:else}
						{rows.length}
						{rows.length === 1 ? 'database' : 'databases'}
					{/if}
				</p>
			</div>

			<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
				<DataTable
					label={trashView ? 'Deleted databases' : 'Databases'}
					{rows}
					columns={trashView ? trashColumns : activeColumns}
					rowId={(row) => row.id}
					search={query.trim()}
					sort={trashView ? { id: 'deleted', desc: true } : { id: 'name', desc: false }}
					onmatch={(count) => (matched = count)}
				/>
			</div>
		{/if}
	{/if}
</div>

{#if data.dbCan.create}
	<FormDialog
		bind:open={createOpen}
		icon={DatabaseIcon}
		title="New database"
		description="A {engine.label} container on one node. Placement is decided once and never moves."
		action="?/create"
		submitLabel="Create database"
	>
		<Field.Group>
			<Field.Set>
				<Field.Legend variant="label">Engine</Field.Legend>
				<div class="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Database engine">
					{#each data.engines as option (option.engine)}
						<label
							class="flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-left transition-colors hover:bg-muted/50 has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-2 has-focus-visible:ring-ring"
						>
							<input
								type="radio"
								name="engine"
								value={option.engine}
								bind:group={engineId}
								class="sr-only"
							/>
							<span class="flex items-center justify-between gap-2">
								<span class="text-sm font-medium">{option.label}</span>
								<Badge variant="outline" class="text-[10px] font-normal"
									>{familyLabel[option.family] ?? option.family}</Badge
								>
							</span>
							<span class="text-xs text-muted-foreground">{option.description}</span>
						</label>
					{/each}
				</div>
				{#if errors.engine}<Field.Error>{errors.engine}</Field.Error>{/if}
			</Field.Set>

			<Field.Field data-invalid={errors.name ? true : undefined}>
				<Field.Label for="database-name">Name</Field.Label>
				<Input
					id="database-name"
					name="name"
					placeholder="app-db"
					minlength={3}
					maxlength={engine.maxNameLength}
					required
					autocapitalize="off"
					spellcheck="false"
					class="font-mono text-sm"
					aria-invalid={errors.name ? 'true' : undefined}
				/>
				<Field.Description>
					3–{engine.maxNameLength} lowercase letters, digits and single hyphens. The {engine.label}
					{engine.family === 'key-value' ? 'user uses' : 'database and user use'} the same name with
					underscores.
				</Field.Description>
				{#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
			</Field.Field>

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.version ? true : undefined}>
					<Field.Label for="database-version">Version</Field.Label>
					{#key engine.engine}
						<NativeSelect.Root
							id="database-version"
							name="version"
							value={engine.defaultVersion}
							class="w-full"
						>
							{#each engine.versions as version (version)}
								<NativeSelect.Option value={version}
									>{engine.label} {version}{version === engine.defaultVersion
										? ' (default)'
										: ''}</NativeSelect.Option
								>
							{/each}
						</NativeSelect.Root>
					{/key}
					{#if errors.version}<Field.Error>{errors.version}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.placement ? true : undefined}>
					<Field.Label for="database-placement">Placement</Field.Label>
					<NativeSelect.Root
						id="database-placement"
						name="placement"
						value="auto"
						class="w-full"
						disabled={attachProject !== ''}
					>
						{#each placementChoices as option (option.value)}
							<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
					{#if attachProject}
						<Field.Description
							>Follows the project's node so the app can reach it.</Field.Description
						>
					{/if}
					{#if errors.placement}<Field.Error>{errors.placement}</Field.Error>{/if}
				</Field.Field>
			</div>

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.memoryMb ? true : undefined}>
					<Field.Label for="database-memory">Memory</Field.Label>
					<InputGroup.Root>
						<InputGroup.Input
							id="database-memory"
							name="memoryMb"
							type="number"
							min={engine.minMemoryMb}
							max={16384}
							step={1}
							value={String(engine.defaultMemoryMb)}
							class="font-mono text-sm"
							aria-invalid={errors.memoryMb ? 'true' : undefined}
						/>
						<InputGroup.Addon align="inline-end">
							<InputGroup.Text class="font-mono text-xs">MB</InputGroup.Text>
						</InputGroup.Addon>
					</InputGroup.Root>
					<Field.Description
						>At least {engine.minMemoryMb} MB, reserved from the node's workload slice.</Field.Description
					>
					{#if errors.memoryMb}<Field.Error>{errors.memoryMb}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.storageMb ? true : undefined}>
					<Field.Label for="database-storage">Storage budget</Field.Label>
					<InputGroup.Root>
						<InputGroup.Input
							id="database-storage"
							name="storageMb"
							type="number"
							min={256}
							max={1048576}
							step={1}
							value="10240"
							class="font-mono text-sm"
							aria-invalid={errors.storageMb ? 'true' : undefined}
						/>
						<InputGroup.Addon align="inline-end">
							<InputGroup.Text class="font-mono text-xs">MB</InputGroup.Text>
						</InputGroup.Addon>
					</InputGroup.Root>
					<Field.Description>For alerts and the gauge; not a hard quota.</Field.Description>
					{#if errors.storageMb}<Field.Error>{errors.storageMb}</Field.Error>{/if}
				</Field.Field>
			</div>

			{#if data.projects.length > 0}
				<div class="grid gap-4 sm:grid-cols-2">
					<Field.Field data-invalid={errors.project ? true : undefined}>
						<Field.Label for="database-project">
							Attach to project <span class="font-normal text-muted-foreground">optional</span>
						</Field.Label>
						<NativeSelect.Root
							id="database-project"
							name="project"
							bind:value={attachProject}
							class="w-full"
						>
							<NativeSelect.Option value="">Don't attach</NativeSelect.Option>
							{#each data.projects as project (project.slug)}
								<NativeSelect.Option value={project.slug}>
									{project.name} ({project.runtime})
								</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
						{#if errors.project}<Field.Error>{errors.project}</Field.Error>{/if}
					</Field.Field>
					{#if attachProject}
						<Field.Field data-invalid={errors.envPrefix ? true : undefined}>
							<Field.Label for="database-prefix">Env prefix</Field.Label>
							<Input
								id="database-prefix"
								name="envPrefix"
								bind:value={envPrefix}
								placeholder={engine.defaultEnvPrefix}
								maxlength={64}
								autocapitalize="characters"
								spellcheck="false"
								class="font-mono text-sm uppercase"
								aria-invalid={errors.envPrefix ? 'true' : undefined}
							/>
							<Field.Description class="font-mono text-xs">
								{(envPrefix || engine.defaultEnvPrefix).toUpperCase()}_URL, _HOST, _PORT …
							</Field.Description>
							{#if errors.envPrefix}<Field.Error>{errors.envPrefix}</Field.Error>{/if}
						</Field.Field>
					{/if}
				</div>
			{/if}
		</Field.Group>
	</FormDialog>
{/if}

{#snippet nameCell(database: Row)}
	<div class="flex items-center gap-3">
		<span
			class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
		>
			<DatabaseIcon class="size-4" />
		</span>
		<div class="min-w-0">
			<a
				href={resolve('/(dashboard)/databases/[name]', { name: database.name })}
				class="font-mono text-sm font-medium underline-offset-4 group-hover:underline"
				>{database.name}</a
			>
			<p class="text-xs text-muted-foreground">{database.engineLabel} {database.version}</p>
		</div>
	</div>
{/snippet}

{#snippet statusCell(database: Row)}
	<StatusBadge status={database.status} />
{/snippet}

{#snippet nodeCell(database: Row)}
	{nodeOf(database)}
{/snippet}

{#snippet storageCell(database: Row)}
	<StorageMeter sizeBytes={database.sizeBytes} storageMb={database.storageMb} compact />
{/snippet}

{#snippet memoryCell(database: Row)}
	{database.memoryMb} MB
{/snippet}

{#snippet attachedCell(database: Row)}
	{#if database.attachments.length === 0}
		<span class="text-xs text-muted-foreground">—</span>
	{:else}
		<div class="flex flex-wrap gap-1.5">
			{#each database.attachments as attachment (attachment.projectId)}
				<Badge
					variant="outline"
					class="font-mono font-normal"
					href={resolve('/(dashboard)/projects/[slug]', { slug: attachment.projectSlug })}
					title="{attachment.envPrefix}_URL"
				>
					<FolderKanbanIcon />{attachment.projectSlug}
				</Badge>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet deletedCell(database: Row)}
	<time datetime={database.deletedAt}>{formatDate(database.deletedAt)}</time>
{/snippet}

{#snippet purgeCell(database: Row)}
	<time datetime={database.purgeAt}>{purgeCountdown(database.purgeAt)}</time>
{/snippet}

{#snippet actionsCell(database: Row)}
	{@const href = resolve('/(dashboard)/databases/[name]', { name: database.name })}
	{#if trashView}
		{#if data.dbCan.delete}
			<RowMenu label="Actions for {database.name}">
				<DropdownMenu.Item onSelect={() => restore(database.name)}>
					<RotateCcwIcon />Restore
				</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item variant="destructive" onSelect={() => purge(database.name)}>
					<TrashIcon />Delete permanently
				</DropdownMenu.Item>
			</RowMenu>
		{/if}
	{:else}
		<RowMenu label="Actions for {database.name}">
			{#if data.dbCan.update}
				<DropdownMenu.Item onSelect={() => restartOne(database.name)}>
					<RotateCcwIcon />Restart
				</DropdownMenu.Item>
				<DropdownMenu.Separator />
			{/if}
			<DropdownMenu.Item onSelect={() => goto(href)}>
				<ArrowRightIcon />Open database
			</DropdownMenu.Item>
			<DropdownMenu.Item onSelect={() => openSection(href, 'metrics')}>
				<ActivityIcon />Metrics
			</DropdownMenu.Item>
			<DropdownMenu.Item onSelect={() => openSection(href, 'backups')}>
				<ArchiveIcon />Backups
			</DropdownMenu.Item>
			<DropdownMenu.Item
				onSelect={() =>
					goto(resolve('/(dashboard)/databases/[name]/logs', { name: database.name }))}
			>
				<ScrollTextIcon />Logs
			</DropdownMenu.Item>
		</RowMenu>
	{/if}
{/snippet}

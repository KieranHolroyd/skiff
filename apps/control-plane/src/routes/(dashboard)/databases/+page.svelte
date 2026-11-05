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
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import RowMenu from '../_lib/RowMenu.svelte';
	import { formatDate } from '../_lib/format.js';
	import { purgeCountdown } from '../_lib/operations/copy.js';
	import StorageMeter from './_lib/StorageMeter.svelte';
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
	let envPrefix = $state('DATABASE');

	const trashView = $derived(data.view === 'trash');
	const rows = $derived(trashView ? data.trash : data.databases);
	const filtered = $derived(
		rows.filter((database) => {
			const q = query.trim().toLowerCase();
			return !q || database.name.includes(q) || (database.nodeName ?? '').toLowerCase().includes(q);
		})
	);

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
		description="Managed PostgreSQL that runs next to your apps. Attach a database to a process or container project and it receives a DATABASE_URL at start-up."
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
					description="Create a PostgreSQL database, then attach it to a project. Apps get connection details as environment variables; the database only listens on its own node."
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
							<InputGroup.Text class="font-mono text-xs">{filtered.length}</InputGroup.Text>
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
				<Table.Root>
					<Table.Header class="bg-muted/45">
						<Table.Row>
							<Table.Head class="pl-4">Database</Table.Head>
							{#if trashView}
								<Table.Head class="hidden sm:table-cell">Node</Table.Head>
								<Table.Head class="hidden sm:table-cell">Deleted</Table.Head>
								<Table.Head>Purge</Table.Head>
							{:else}
								<Table.Head>Status</Table.Head>
								<Table.Head class="hidden md:table-cell">Node</Table.Head>
								<Table.Head class="hidden lg:table-cell">Storage</Table.Head>
								<Table.Head class="hidden md:table-cell">Memory</Table.Head>
								<Table.Head class="hidden lg:table-cell">Attached to</Table.Head>
							{/if}
							<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each filtered as database (database.id)}
							{@const href = resolve('/(dashboard)/databases/[name]', { name: database.name })}
							<Table.Row class="group">
								<Table.Cell class="pl-4">
									<div class="flex items-center gap-3">
										<span
											class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
										>
											<DatabaseIcon class="size-4" />
										</span>
										<div class="min-w-0">
											<a
												{href}
												class="font-mono text-sm font-medium underline-offset-4 group-hover:underline"
												>{database.name}</a
											>
											<p class="text-xs text-muted-foreground">
												{database.engineLabel}
												{database.version}
											</p>
										</div>
									</div>
								</Table.Cell>
								{#if trashView}
									<Table.Cell class="hidden font-mono text-xs text-muted-foreground sm:table-cell">
										{database.nodeName ?? database.nodeId}
									</Table.Cell>
									<Table.Cell class="hidden font-mono text-xs text-muted-foreground sm:table-cell">
										<time datetime={database.deletedAt}>{formatDate(database.deletedAt)}</time>
									</Table.Cell>
									<Table.Cell class="text-xs text-muted-foreground">
										<time datetime={database.purgeAt}>{purgeCountdown(database.purgeAt)}</time>
									</Table.Cell>
								{:else}
									<Table.Cell>
										<StatusBadge status={database.status} />
									</Table.Cell>
									<Table.Cell class="hidden font-mono text-xs md:table-cell">
										{database.nodeName ?? database.nodeId}
									</Table.Cell>
									<Table.Cell class="hidden w-48 lg:table-cell">
										<StorageMeter
											sizeBytes={database.sizeBytes}
											storageMb={database.storageMb}
											compact
										/>
									</Table.Cell>
									<Table.Cell class="hidden font-mono text-xs tabular-nums md:table-cell">
										{database.memoryMb} MB
									</Table.Cell>
									<Table.Cell class="hidden lg:table-cell">
										{#if database.attachments.length === 0}
											<span class="text-xs text-muted-foreground">—</span>
										{:else}
											<div class="flex flex-wrap gap-1.5">
												{#each database.attachments as attachment (attachment.projectId)}
													<Badge
														variant="outline"
														class="font-mono font-normal"
														href={resolve('/(dashboard)/projects/[slug]', {
															slug: attachment.projectSlug
														})}
														title="{attachment.envPrefix}_URL"
													>
														<FolderKanbanIcon />{attachment.projectSlug}
													</Badge>
												{/each}
											</div>
										{/if}
									</Table.Cell>
								{/if}
								<Table.Cell class="pr-4">
									{#if trashView}
										{#if data.dbCan.delete}
											<RowMenu label="Actions for {database.name}">
												<DropdownMenu.Item onSelect={() => restore(database.name)}>
													<RotateCcwIcon />Restore
												</DropdownMenu.Item>
												<DropdownMenu.Separator />
												<DropdownMenu.Item
													variant="destructive"
													onSelect={() => purge(database.name)}
												>
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
													goto(
														resolve('/(dashboard)/databases/[name]/logs', { name: database.name })
													)}
											>
												<ScrollTextIcon />Logs
											</DropdownMenu.Item>
										</RowMenu>
									{/if}
								</Table.Cell>
							</Table.Row>
						{:else}
							<Table.Row>
								<Table.Cell colspan={7} class="py-10 text-center text-sm text-muted-foreground">
									No databases match “{query}”.
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div>
		{/if}
	{/if}
</div>

{#if data.dbCan.create}
	<FormDialog
		bind:open={createOpen}
		icon={DatabaseIcon}
		title="New database"
		description="A {data.engine
			.label} container on one node. Placement is decided once and never moves."
		action="?/create"
		submitLabel="Create database"
	>
		<Field.Group>
			<Field.Field data-invalid={errors.name ? true : undefined}>
				<Field.Label for="database-name">Name</Field.Label>
				<Input
					id="database-name"
					name="name"
					placeholder="app-db"
					minlength={3}
					maxlength={40}
					required
					autocapitalize="off"
					spellcheck="false"
					class="font-mono text-sm"
					aria-invalid={errors.name ? 'true' : undefined}
				/>
				<Field.Description>
					3–40 lowercase letters, digits and single hyphens. The Postgres database and user use the
					same name with underscores.
				</Field.Description>
				{#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
			</Field.Field>

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.version ? true : undefined}>
					<Field.Label for="database-version">Version</Field.Label>
					<NativeSelect.Root
						id="database-version"
						name="version"
						value={data.engine.defaultVersion}
						class="w-full"
					>
						{#each data.engine.versions as version (version)}
							<NativeSelect.Option value={version}
								>{data.engine.label} {version}</NativeSelect.Option
							>
						{/each}
					</NativeSelect.Root>
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
							min={data.engine.minMemoryMb}
							max={16384}
							step={1}
							value={String(data.engine.defaultMemoryMb)}
							class="font-mono text-sm"
							aria-invalid={errors.memoryMb ? 'true' : undefined}
						/>
						<InputGroup.Addon align="inline-end">
							<InputGroup.Text class="font-mono text-xs">MB</InputGroup.Text>
						</InputGroup.Addon>
					</InputGroup.Root>
					<Field.Description>Reserved from the node's workload slice.</Field.Description>
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
								maxlength={64}
								autocapitalize="characters"
								spellcheck="false"
								class="font-mono text-sm uppercase"
								aria-invalid={errors.envPrefix ? 'true' : undefined}
							/>
							<Field.Description class="font-mono text-xs">
								{(envPrefix || 'DATABASE').toUpperCase()}_URL, _HOST, _PORT …
							</Field.Description>
							{#if errors.envPrefix}<Field.Error>{errors.envPrefix}</Field.Error>{/if}
						</Field.Field>
					{/if}
				</div>
			{/if}
		</Field.Group>
	</FormDialog>
{/if}

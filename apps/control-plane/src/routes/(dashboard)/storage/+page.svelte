<script lang="ts">
	import StoragePoolSelect from '#lib/components/skiff/StoragePoolSelect.svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CylinderIcon from '@lucide/svelte/icons/cylinder';
	import EarthIcon from '@lucide/svelte/icons/earth';
	import LockIcon from '@lucide/svelte/icons/lock';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { storageEnvNames } from '@skiff/contracts';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import DataTable, { type DataColumn } from '#lib/components/skiff/DataTable.svelte';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import RowMenu from '../_lib/RowMenu.svelte';
	import { formatDate } from '../_lib/format.js';
	import { purgeCountdown } from '../_lib/operations/copy.js';
	import StorageMeter from '../databases/_lib/StorageMeter.svelte';
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
	let envPrefix = $state('S3');
	let createPublic = $state(false);
	let bucketsText = $state('');

	const trashView = $derived(data.view === 'trash');
	const rows = $derived(trashView ? data.trash : data.instances);
	let matched = $state(0);

	type Row = PageProps['data']['instances'][number];
	const nodeOf = (row: Row) => row.nodeName ?? row.nodeId;
	const liveBuckets = (row: Row) =>
		row.buckets.filter((bucket) => bucket.state !== 'deleting').length;
	const nameColumn: DataColumn<Row> = {
		id: 'name',
		header: 'Instance',
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
			id: 'access',
			header: 'Access',
			value: (row) => (row.public ? 'public' : 'private'),
			cell: accessCell,
			class: 'hidden sm:table-cell'
		},
		{
			id: 'node',
			header: 'Node',
			value: nodeOf,
			cell: nodeCell,
			class: 'hidden font-mono text-xs md:table-cell'
		},
		{
			id: 'used',
			header: 'Used',
			value: (row) => row.usedBytes,
			searchable: false,
			descFirst: true,
			cell: usedCell,
			class: 'hidden w-48 lg:table-cell'
		},
		{
			id: 'buckets',
			header: 'Buckets',
			value: liveBuckets,
			searchable: false,
			descFirst: true,
			cell: bucketsCell,
			class: 'hidden text-right font-mono text-xs tabular-nums md:table-cell'
		},
		{
			id: 'attached',
			header: 'Attached to',
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
	/** Private instances must share the app's node, so attaching on create decides placement. */
	const placementFollowsProject = $derived(attachProject !== '' && !createPublic);
	const typedBuckets = $derived(
		bucketsText
			.split(/[\s,]+/)
			.map((name) => name.trim().toLowerCase())
			.filter(Boolean)
	);
	const prefixPreview = $derived(
		storageEnvNames((envPrefix || 'S3').toUpperCase(), {
			public: createPublic,
			singleBucket: typedBuckets.length === 1
		})
	);

	function setView(value: string) {
		const href = resolve('/(dashboard)/storage');
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
				'The RustFS container restarts. S3 requests and attached apps fail briefly; buckets, objects and keys are kept.',
			confirmLabel: 'Restart',
			tone: 'danger',
			action: '?/restart',
			fields: { name }
		});
	}

	function restartAll(scope: 'storage' | 'all') {
		askConfirm({
			title: scope === 'all' ? 'Restart all services?' : 'Restart all storage?',
			description:
				scope === 'all'
					? 'Every managed storage instance and database restarts. S3 requests and app connections fail briefly; buckets, objects and keys are kept.'
					: 'Every managed storage instance restarts. S3 requests fail briefly; buckets, objects and keys are kept.',
			confirmLabel: 'Restart all',
			tone: 'danger',
			action: scope === 'all' ? '?/restart-all-services' : '?/restart-all'
		});
	}

	function purge(name: string) {
		askConfirm({
			title: `Delete ${name} permanently?`,
			description:
				'Its node deletes the data directory with every bucket and object, and the instance is gone for good. This cannot be undone.',
			confirmLabel: 'Delete permanently',
			tone: 'danger',
			typeToConfirm: name,
			action: '?/purge',
			fields: { name }
		});
	}
</script>

<svelte:head>
	<title>{trashView ? 'Storage trash' : 'Storage'} · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		target="page.storage"
		eyebrow="Workloads"
		title="Storage"
		description="Managed S3-compatible object storage (RustFS). Attach an instance to a process or container project and it receives an endpoint and its own scoped access key at start-up."
	>
		{#if data.storageCan.update && !trashView && data.instances.length > 0}
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
					<DropdownMenu.Item onSelect={() => restartAll('storage')}>
						<RotateCcwIcon />Restart all storage
					</DropdownMenu.Item>
					<DropdownMenu.Separator />
					<DropdownMenu.Item onSelect={() => restartAll('all')}>
						<RotateCcwIcon />Restart all services
						<span class="ml-auto text-xs text-muted-foreground">+ databases</span>
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/if}
		{#if data.storageCan.create}
			<Button onclick={() => (createOpen = true)}>
				<PlusIcon />
				New storage
			</Button>
		{/if}
	</PageHeader>

	{#if data.denied}
		<EmptyState
			icon={ShieldAlertIcon}
			title="Storage is not visible"
			description="This account does not have the storage:read permission."
		/>
	{:else}
		<Tabs.Root value={data.view} onValueChange={setView}>
			<Tabs.List variant="line" class="w-full justify-start border-b" aria-label="Storage lists">
				<Tabs.Trigger value="live" class="flex-none">
					<CylinderIcon />
					Instances
					<span class="font-mono text-xs text-muted-foreground">{data.instances.length}</span>
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
					description={`Deleted storage instances stay here for ${data.policies.trashDays} days with their buckets intact, then they are permanently deleted.`}
				/>
			{:else}
				<EmptyState
					icon={CylinderIcon}
					title="No storage yet"
					description="Create an S3-compatible storage instance, add buckets, then attach it to a project. It stays private to its node unless you make it public."
				>
					{#if data.storageCan.create}
						<Button onclick={() => (createOpen = true)}><PlusIcon />Create storage</Button>
					{/if}
				</EmptyState>
			{/if}
		{:else}
			<div class="flex flex-wrap items-center justify-between gap-3">
				<InputGroup.Root class="max-w-xs bg-card">
					<InputGroup.Input
						placeholder={trashView ? 'Search the trash' : 'Search storage'}
						bind:value={query}
						aria-label={trashView ? 'Search the trash' : 'Search storage'}
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
						{rows.length} in the trash · purged after {data.policies.trashDays} days
					{:else}
						{rows.length}
						{rows.length === 1 ? 'instance' : 'instances'}
					{/if}
				</p>
			</div>

			<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
				<DataTable
					label={trashView ? 'Deleted storage' : 'Object storage'}
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

{#if data.storageCan.create}
	<FormDialog
		bind:open={createOpen}
		icon={CylinderIcon}
		title="New storage"
		description="A {data.engine
			.label} container on one node serving the S3 API. Placement is decided once and never moves."
		action="?/create"
		submitLabel="Create storage"
		size="lg"
	>
		<Field.Group>
			<Field.Field data-invalid={errors.name ? true : undefined}>
				<Field.Label for="storage-name">Name</Field.Label>
				<Input
					id="storage-name"
					name="name"
					placeholder="media"
					minlength={3}
					maxlength={40}
					required
					autocapitalize="off"
					spellcheck="false"
					class="font-mono text-sm"
					aria-invalid={errors.name ? 'true' : undefined}
				/>
				<Field.Description>3–40 lowercase letters, digits and single hyphens.</Field.Description>
				{#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
			</Field.Field>

			<Field.Field data-invalid={errors.buckets ? true : undefined}>
				<Field.Label for="storage-buckets">
					Buckets <span class="font-normal text-muted-foreground">optional</span>
				</Field.Label>
				<Input
					id="storage-buckets"
					name="buckets"
					bind:value={bucketsText}
					placeholder="uploads, avatars"
					autocapitalize="off"
					spellcheck="false"
					class="font-mono text-sm"
					aria-invalid={errors.buckets ? 'true' : undefined}
				/>
				{#if typedBuckets.length > 0}
					<div class="flex flex-wrap gap-1.5">
						{#each typedBuckets as bucket, index (`${bucket}-${index}`)}
							<Badge variant="secondary" class="font-mono font-normal">{bucket}</Badge>
						{/each}
					</div>
				{/if}
				<Field.Description>
					Comma-separated. 3–63 lowercase letters, digits and hyphens, no dots. All start private;
					you can add more later.
				</Field.Description>
				{#if errors.buckets}<Field.Error>{errors.buckets}</Field.Error>{/if}
			</Field.Field>

			<Field.Field orientation="horizontal">
				<Switch id="storage-public" bind:checked={createPublic} />
				<input type="hidden" name="public" value={createPublic ? 'true' : ''} />
				<Field.Content>
					<Field.Label for="storage-public">Public endpoint</Field.Label>
					<Field.Description>
						Serve the S3 API at <code class="font-mono">&lt;name&gt;--s3.{data.contentDomain}</code
						>, authenticated by S3 signatures. Off keeps it on loopback and the workload network of
						its node.
					</Field.Description>
				</Field.Content>
			</Field.Field>
			{#if createPublic}
				<Notice tone="warning" title="Public traffic goes through the edge">
					Every upload and download passes through the edge VPS, and over WireGuard when the
					instance lands on a worker node. Large files count against the edge's bandwidth.
				</Notice>
			{/if}

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.placement ? true : undefined}>
					<Field.Label for="storage-placement">Placement</Field.Label>
					<NativeSelect.Root
						id="storage-placement"
						name="placement"
						value="auto"
						class="w-full"
						disabled={placementFollowsProject}
					>
						{#each placementChoices as option (option.value)}
							<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
					{#if placementFollowsProject}
						<Field.Description>
							Follows the project's node: private storage is only reachable there.
						</Field.Description>
					{/if}
					{#if errors.placement}<Field.Error>{errors.placement}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.storageMb ? true : undefined}>
					<Field.Label for="storage-budget">Storage budget</Field.Label>
					<InputGroup.Root>
						<InputGroup.Input
							id="storage-budget"
							name="storageMb"
							type="number"
							min={256}
							max={10485760}
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
			<StoragePoolSelect choices={data.storageChoices} id="storage-pool" value={(form as { values?: { pool?: string } } | null)?.values?.pool ?? ''} />

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.memoryMb ? true : undefined}>
					<Field.Label for="storage-memory">Memory</Field.Label>
					<InputGroup.Root>
						<InputGroup.Input
							id="storage-memory"
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
					<Field.Description>
						At least {data.engine.minMemoryMb} MB, reserved from the node's workload slice.
					</Field.Description>
					{#if errors.memoryMb}<Field.Error>{errors.memoryMb}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.cpus ? true : undefined}>
					<Field.Label for="storage-cpus">CPUs</Field.Label>
					<InputGroup.Root>
						<InputGroup.Input
							id="storage-cpus"
							name="cpus"
							type="number"
							min={0.1}
							max={8}
							step={0.1}
							value="1"
							class="font-mono text-sm"
							aria-invalid={errors.cpus ? 'true' : undefined}
						/>
						<InputGroup.Addon align="inline-end">
							<InputGroup.Text class="font-mono text-xs">vCPU</InputGroup.Text>
						</InputGroup.Addon>
					</InputGroup.Root>
					{#if errors.cpus}<Field.Error>{errors.cpus}</Field.Error>{/if}
				</Field.Field>
			</div>

			{#if data.projects.length > 0}
				<div class="grid gap-4 sm:grid-cols-2">
					<Field.Field data-invalid={errors.project ? true : undefined}>
						<Field.Label for="storage-project">
							Attach to project <span class="font-normal text-muted-foreground">optional</span>
						</Field.Label>
						<NativeSelect.Root
							id="storage-project"
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
						{#if attachProject}
							<Field.Description>Gets read-write on every bucket created here.</Field.Description>
						{/if}
						{#if errors.project}<Field.Error>{errors.project}</Field.Error>{/if}
					</Field.Field>
					{#if attachProject}
						<Field.Field data-invalid={errors.envPrefix ? true : undefined}>
							<Field.Label for="storage-prefix">Env prefix</Field.Label>
							<Input
								id="storage-prefix"
								name="envPrefix"
								bind:value={envPrefix}
								maxlength={64}
								autocapitalize="characters"
								spellcheck="false"
								class="font-mono text-sm uppercase"
								aria-invalid={errors.envPrefix ? 'true' : undefined}
							/>
							<Field.Description>
								<code class="font-mono">AWS</code> gives the AWS SDKs' own variable names.
							</Field.Description>
							{#if errors.envPrefix}<Field.Error>{errors.envPrefix}</Field.Error>{/if}
						</Field.Field>
					{/if}
				</div>
				{#if attachProject}
					<div class="flex flex-wrap gap-1.5">
						{#each prefixPreview as name (name)}
							<Badge variant="secondary" class="font-mono font-normal">{name}</Badge>
						{/each}
					</div>
					{#if typedBuckets.length === 0}
						<p class="text-xs text-destructive">
							Add at least one bucket above to attach a project on create.
						</p>
					{/if}
				{/if}
			{/if}
		</Field.Group>
	</FormDialog>
{/if}

{#snippet nameCell(item: Row)}
	<div class="flex items-center gap-3">
		<span
			class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
		>
			<CylinderIcon class="size-4" />
		</span>
		<div class="min-w-0">
			<a
				href={resolve('/(dashboard)/storage/[name]', { name: item.name })}
				class="font-mono text-sm font-medium underline-offset-4 group-hover:underline"
				>{item.name}</a
			>
			<p class="text-xs text-muted-foreground">{item.engineLabel} {item.version}</p>
		</div>
	</div>
{/snippet}

{#snippet statusCell(item: Row)}
	<StatusBadge status={item.status} />
{/snippet}

{#snippet accessCell(item: Row)}
	{#if item.public}
		<Badge variant="info" title={item.publicUrl ?? undefined}><EarthIcon />Public</Badge>
	{:else}
		<Badge variant="outline"><LockIcon />Private</Badge>
	{/if}
{/snippet}

{#snippet nodeCell(item: Row)}
	{nodeOf(item)}
{/snippet}

{#snippet usedCell(item: Row)}
	<StorageMeter sizeBytes={item.usedBytes} storageMb={item.storageMb} compact />
{/snippet}

{#snippet bucketsCell(item: Row)}
	{liveBuckets(item)}
{/snippet}

{#snippet attachedCell(item: Row)}
	{#if item.attachments.length === 0}
		<span class="text-xs text-muted-foreground">—</span>
	{:else}
		<div class="flex flex-wrap gap-1.5">
			{#each item.attachments as attachment (attachment.projectId)}
				<Badge
					variant="outline"
					class="font-mono font-normal"
					href={resolve('/(dashboard)/projects/[slug]', { slug: attachment.projectSlug })}
					title="{attachment.envPrefix}_* · {attachment.grants.length} bucket grants"
				>
					<FolderKanbanIcon />{attachment.projectSlug}
				</Badge>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet deletedCell(item: Row)}
	<time datetime={item.deletedAt}>{formatDate(item.deletedAt)}</time>
{/snippet}

{#snippet purgeCell(item: Row)}
	<time datetime={item.purgeAt}>{purgeCountdown(item.purgeAt)}</time>
{/snippet}

{#snippet actionsCell(item: Row)}
	{@const href = resolve('/(dashboard)/storage/[name]', { name: item.name })}
	{#if trashView}
		{#if data.storageCan.delete}
			<RowMenu label="Actions for {item.name}">
				<DropdownMenu.Item onSelect={() => restore(item.name)}>
					<RotateCcwIcon />Restore
				</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item variant="destructive" onSelect={() => purge(item.name)}>
					<TrashIcon />Delete permanently
				</DropdownMenu.Item>
			</RowMenu>
		{/if}
	{:else}
		<RowMenu label="Actions for {item.name}">
			{#if data.storageCan.update}
				<DropdownMenu.Item onSelect={() => restartOne(item.name)}>
					<RotateCcwIcon />Restart
				</DropdownMenu.Item>
				<DropdownMenu.Separator />
			{/if}
			<DropdownMenu.Item onSelect={() => goto(href)}>
				<ArrowRightIcon />Open storage
			</DropdownMenu.Item>
			<DropdownMenu.Item onSelect={() => openSection(href, 'buckets')}>
				<ArchiveIcon />Buckets
			</DropdownMenu.Item>
			<DropdownMenu.Item
				onSelect={() => goto(resolve('/(dashboard)/storage/[name]/objects', { name: item.name }))}
			>
				<FolderOpenIcon />Browse objects
			</DropdownMenu.Item>
			<DropdownMenu.Item
				onSelect={() => goto(resolve('/(dashboard)/storage/[name]/logs', { name: item.name }))}
			>
				<ScrollTextIcon />Logs
			</DropdownMenu.Item>
		</RowMenu>
	{/if}
{/snippet}

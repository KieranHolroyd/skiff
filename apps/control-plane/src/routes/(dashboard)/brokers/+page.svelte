<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { brokerEnvNames } from '@skiff/contracts';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import DataTable, { type DataColumn } from '#lib/components/skiff/DataTable.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import { formatBytes } from '../_lib/format.js';
	import PageHeader from '../_lib/PageHeader.svelte';
	import RowMenu from '../_lib/RowMenu.svelte';
	import { formatDate } from '../_lib/format.js';
	import { purgeCountdown } from '../_lib/operations/copy.js';
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
	let envPrefix = $state('NATS');

	const trashView = $derived(data.view === 'trash');
	const rows = $derived(trashView ? data.trash : data.brokers);
	let matched = $state(0);

	type Row = PageProps['data']['brokers'][number];
	const nodeOf = (row: Row) => row.nodeName ?? row.nodeId;
	const nameColumn: DataColumn<Row> = {
		id: 'name',
		header: 'Broker',
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
			id: 'limits',
			header: 'Memory · store',
			value: (row) => row.storageMb,
			searchable: false,
			descFirst: true,
			cell: limitsCell,
			class: 'hidden font-mono text-xs tabular-nums lg:table-cell'
		},
		{
			id: 'stored',
			header: 'Stored',
			value: (row) => row.storeBytes ?? -1,
			searchable: false,
			descFirst: true,
			cell: storedCell,
			class: 'hidden font-mono text-xs tabular-nums xl:table-cell'
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
			.map((item) => ({ value: item.nodeId, label: `${item.name} (${item.freeMemoryMb} MB free)` }))
	]);
	const prefixPreview = $derived(brokerEnvNames((envPrefix || 'NATS').toUpperCase()));

	function setView(value: string) {
		const href = resolve('/(dashboard)/brokers');
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route, only `?view` changes
		void goto(value === 'trash' ? `${href}?view=trash` : href);
	}

	function restartOne(name: string) {
		askConfirm({
			title: `Restart ${name}?`,
			description:
				'The broker container restarts. Connected clients reconnect; streams, consumers and stored messages are kept.',
			confirmLabel: 'Restart',
			tone: 'danger',
			action: '?/restart',
			fields: { name }
		});
	}

	function purge(name: string) {
		askConfirm({
			title: `Delete ${name} permanently?`,
			description:
				'Its node deletes the data directory with every stream and stored message, and the broker is gone for good. This cannot be undone.',
			confirmLabel: 'Delete permanently',
			tone: 'danger',
			typeToConfirm: name,
			action: '?/purge',
			fields: { name }
		});
	}
</script>

<svelte:head>
	<title>{trashView ? 'Queue trash' : 'Queues'} · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		target="page.brokers"
		eyebrow="Workloads"
		title="Queues"
		description="Managed message brokers (NATS with JetStream). Attach one to a process or container project and it receives NATS_URL and credentials at start-up."
	>
		{#if data.brokerCan.create && data.enabled}
			<Button onclick={() => (createOpen = true)}>
				<PlusIcon />
				New broker
			</Button>
		{/if}
	</PageHeader>

	{#if !data.enabled}
		<Notice tone="warning" title="Queue brokers are switched off">
			Set <code class="font-mono">SKIFF_FEATURE_BROKERS=1</code> to create new brokers. Existing ones keep
			running.
		</Notice>
	{/if}

	{#if data.denied}
		<EmptyState
			icon={ShieldAlertIcon}
			title="Brokers are not visible"
			description="This account does not have the broker:read permission."
		/>
	{:else}
		<Tabs.Root value={data.view} onValueChange={setView}>
			<Tabs.List variant="line" class="w-full justify-start border-b" aria-label="Broker lists">
				<Tabs.Trigger value="live" class="flex-none">
					<InboxIcon />
					Brokers
					<span class="font-mono text-xs text-muted-foreground">{data.brokers.length}</span>
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
					description={`Deleted brokers stay here for ${data.policies.trashDays} days with their streams intact, then they are permanently deleted.`}
				/>
			{:else}
				<EmptyState
					icon={InboxIcon}
					title="No brokers yet"
					description="Create a NATS broker for background jobs, events and fan-out, then attach it to the projects that publish and consume. It stays private to its node."
				>
					{#if data.brokerCan.create && data.enabled}
						<Button onclick={() => (createOpen = true)}><PlusIcon />Create broker</Button>
					{/if}
				</EmptyState>
			{/if}
		{:else}
			<div class="flex flex-wrap items-center justify-between gap-3">
				<InputGroup.Root class="max-w-xs bg-card">
					<InputGroup.Input
						placeholder={trashView ? 'Search the trash' : 'Search brokers'}
						bind:value={query}
						aria-label={trashView ? 'Search the trash' : 'Search brokers'}
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
						{rows.length === 1 ? 'broker' : 'brokers'}
					{/if}
				</p>
			</div>

			<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
				<DataTable
					label={trashView ? 'Deleted brokers' : 'Queue brokers'}
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

{#if data.brokerCan.create && data.enabled}
	<FormDialog
		bind:open={createOpen}
		icon={InboxIcon}
		title="New broker"
		description="A {data.engine
			.label} server with JetStream on one node. Placement is decided once and never moves."
		action="?/create"
		submitLabel="Create broker"
		size="lg"
	>
		<Field.Group>
			<Field.Field data-invalid={errors.name ? true : undefined}>
				<Field.Label for="broker-name">Name</Field.Label>
				<Input
					id="broker-name"
					name="name"
					placeholder="jobs"
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

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.version ? true : undefined}>
					<Field.Label for="broker-version">Version</Field.Label>
					<NativeSelect.Root
						id="broker-version"
						name="version"
						value={data.engine.defaultVersion}
						class="w-full"
					>
						{#each data.engine.versions as version (version)}
							<NativeSelect.Option value={version}>{data.engine.label} {version}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
					{#if errors.version}<Field.Error>{errors.version}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.placement ? true : undefined}>
					<Field.Label for="broker-placement">Placement</Field.Label>
					<NativeSelect.Root
						id="broker-placement"
						name="placement"
						value="auto"
						class="w-full"
						disabled={attachProject !== ''}
					>
						{#each placementChoices as option (option.value)}
							<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
					{#if attachProject !== ''}
						<Field.Description>Follows the project's node: a broker is only reachable there.</Field.Description>
					{/if}
					{#if errors.placement}<Field.Error>{errors.placement}</Field.Error>{/if}
				</Field.Field>
			</div>

			<div class="grid gap-4 sm:grid-cols-3">
				<Field.Field data-invalid={errors.memoryMb ? true : undefined}>
					<Field.Label for="broker-memory">Memory</Field.Label>
					<InputGroup.Root>
						<InputGroup.Input
							id="broker-memory"
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
					{#if errors.memoryMb}<Field.Error>{errors.memoryMb}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.cpus ? true : undefined}>
					<Field.Label for="broker-cpus">CPUs</Field.Label>
					<InputGroup.Root>
						<InputGroup.Input
							id="broker-cpus"
							name="cpus"
							type="number"
							min={0.1}
							max={8}
							step={0.1}
							value="0.5"
							class="font-mono text-sm"
							aria-invalid={errors.cpus ? 'true' : undefined}
						/>
						<InputGroup.Addon align="inline-end">
							<InputGroup.Text class="font-mono text-xs">vCPU</InputGroup.Text>
						</InputGroup.Addon>
					</InputGroup.Root>
					{#if errors.cpus}<Field.Error>{errors.cpus}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.storageMb ? true : undefined}>
					<Field.Label for="broker-store">Message store</Field.Label>
					<InputGroup.Root>
						<InputGroup.Input
							id="broker-store"
							name="storageMb"
							type="number"
							min={256}
							max={1048576}
							step={1}
							value="2048"
							class="font-mono text-sm"
							aria-invalid={errors.storageMb ? 'true' : undefined}
						/>
						<InputGroup.Addon align="inline-end">
							<InputGroup.Text class="font-mono text-xs">MB</InputGroup.Text>
						</InputGroup.Addon>
					</InputGroup.Root>
					{#if errors.storageMb}<Field.Error>{errors.storageMb}</Field.Error>{/if}
				</Field.Field>
			</div>
			<p class="text-xs text-muted-foreground">
				Memory is reserved from the node's workload slice (at least {data.engine.minMemoryMb} MB). The
				message store is a hard cap: a full broker refuses new messages instead of filling the disk.
			</p>

			{#if data.projects.length > 0}
				<div class="grid gap-4 sm:grid-cols-2">
					<Field.Field data-invalid={errors.project ? true : undefined}>
						<Field.Label for="broker-project">
							Attach to project <span class="font-normal text-muted-foreground">optional</span>
						</Field.Label>
						<NativeSelect.Root id="broker-project" name="project" bind:value={attachProject} class="w-full">
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
							<Field.Label for="broker-prefix">Env prefix</Field.Label>
							<Input
								id="broker-prefix"
								name="envPrefix"
								bind:value={envPrefix}
								maxlength={64}
								autocapitalize="characters"
								spellcheck="false"
								class="font-mono text-sm uppercase"
								aria-invalid={errors.envPrefix ? 'true' : undefined}
							/>
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
			<InboxIcon class="size-4" />
		</span>
		<div class="min-w-0">
			<a
				href={resolve('/(dashboard)/brokers/[name]', { name: item.name })}
				class="font-mono text-sm font-medium underline-offset-4 group-hover:underline">{item.name}</a
			>
			<p class="text-xs text-muted-foreground">{item.engineLabel} {item.version}</p>
		</div>
	</div>
{/snippet}

{#snippet statusCell(item: Row)}
	<StatusBadge status={item.status} />
{/snippet}

{#snippet nodeCell(item: Row)}
	{nodeOf(item)}
{/snippet}

{#snippet limitsCell(item: Row)}
	{item.memoryMb} MB · {item.storageMb} MB
{/snippet}

{#snippet storedCell(item: Row)}
	{#if item.storeBytes === null}
		<span class="text-muted-foreground">—</span>
	{:else}
		{formatBytes(item.storeBytes)}{#if item.messages !== null}<span class="text-muted-foreground">
				· {item.messages.toLocaleString('en-GB')} msgs</span
			>{/if}
	{/if}
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
					title="{attachment.envPrefix}_*"
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
	{@const href = resolve('/(dashboard)/brokers/[name]', { name: item.name })}
	{#if trashView}
		{#if data.brokerCan.delete}
			<RowMenu label="Actions for {item.name}">
				<DropdownMenu.Item onSelect={() => void runAction('?/restore', { name: item.name })}>
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
			{#if data.brokerCan.update}
				<DropdownMenu.Item onSelect={() => restartOne(item.name)}>
					<RotateCcwIcon />Restart
				</DropdownMenu.Item>
				<DropdownMenu.Separator />
			{/if}
			<DropdownMenu.Item onSelect={() => goto(href)}>
				<ArrowRightIcon />Open broker
			</DropdownMenu.Item>
			<DropdownMenu.Item
				onSelect={() => goto(resolve('/(dashboard)/brokers/[name]/logs', { name: item.name }))}
			>
				<ScrollTextIcon />Logs
			</DropdownMenu.Item>
		</RowMenu>
	{/if}
{/snippet}

<script lang="ts">
	import { browser } from '$app/env';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { createQuery } from '@tanstack/svelte-query';
	import BellIcon from '@lucide/svelte/icons/bell';
	import CylinderIcon from '@lucide/svelte/icons/cylinder';
	import DatabaseBackupIcon from '@lucide/svelte/icons/database-backup';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PowerIcon from '@lucide/svelte/icons/power';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SendIcon from '@lucide/svelte/icons/send';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import WebhookIcon from '@lucide/svelte/icons/webhook';
	import type { EventDeliveryView, EventRuleView, EventSource } from '@skiff/contracts';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import DataTable, { type DataColumn } from '#lib/components/skiff/DataTable.svelte';
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
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import { errorText, fetchJson } from '#lib/query.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import RowMenu from '../_lib/RowMenu.svelte';
	import { formatDate } from '../_lib/format.js';
	import type { PageProps } from './$types';

	interface CreateFormResult {
		message?: string;
		fieldErrors?: Record<string, string>;
		created?: string;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as CreateFormResult | null);
	const errors = $derived(result?.fieldErrors ?? {});

	const SOURCES: Record<EventSource, { label: string; icon: typeof BellIcon; blurb: string }> = {
		storage: {
			label: 'Storage',
			icon: CylinderIcon,
			blurb: 'Objects created or deleted in a bucket'
		},
		alerts: { label: 'Alerts', icon: BellIcon, blurb: 'An alert rule firing or resolving' },
		deployments: {
			label: 'Deployments',
			icon: RocketIcon,
			blurb: 'A deployment created, promoted or a build failing'
		},
		'database-backups': {
			label: 'Database backups',
			icon: DatabaseBackupIcon,
			blurb: 'A database backup finishing or failing'
		}
	};
	const EVENT_LABELS: Record<string, string> = {
		'object-create': 'Object created',
		'object-delete': 'Object deleted',
		firing: 'Firing',
		resolved: 'Resolved',
		created: 'Created',
		promoted: 'Promoted',
		failed: 'Failed',
		completed: 'Completed'
	};

	let createOpen = $state(page.url.searchParams.get('new') === '1');
	let query = $state('');
	let matched = $state(0);
	let source = $state<EventSource>('storage');
	let storageName = $state('');
	let broker = $state('');
	let queueName = $state('');

	const tab = $derived(data.view);
	const sourceEvents = $derived(data.sources.find((item) => item.source === source)?.events ?? []);
	const buckets = $derived(data.storage.find((item) => item.name === storageName)?.buckets ?? []);
	const consumerSnippet = $derived(
		`"queues": { "consumers": [{ "queue": "${queueName || 'my-queue'}" }] }`
	);

	$effect(() => {
		if (!storageName && data.storage[0]) storageName = data.storage[0].name;
		if (!broker && data.brokers[0]) broker = data.brokers[0].name;
	});
	$effect(() => {
		// Close the dialog once the rule exists; the toast says what happens next.
		if (result?.created) createOpen = false;
	});

	/** Deliveries change after render (the broker's node publishes them), so poll while the tab is open. */
	const live = createQuery(() => ({
		queryKey: ['event-deliveries'] as const,
		queryFn: ({ signal }) =>
			fetchJson<{ deliveries: EventDeliveryView[] }>('/api/v1/events/deliveries?limit=100', {
				signal,
				cache: 'no-store'
			}),
		enabled: browser && tab === 'deliveries' && !data.denied,
		refetchInterval: 5_000,
		staleTime: 0
	}));
	const deliveries = $derived(live.data?.deliveries ?? data.deliveries);
	const ruleById = $derived(new Map(data.rules.map((rule) => [rule.id, rule])));

	function watching(rule: EventRuleView): string {
		const filter = rule.filter;
		switch (rule.source) {
			case 'storage': {
				const keys =
					filter.prefix || filter.suffix ? ` · ${filter.prefix ?? ''}*${filter.suffix ?? ''}` : '';
				return `${filter.storage}/${filter.bucket}${keys}`;
			}
			case 'deployments':
				return filter.project ? `Project ${filter.project}` : 'Every project';
			case 'database-backups':
				return filter.database ? `Database ${filter.database}` : 'Every database';
			case 'alerts': {
				const named = data.alertRules.find((item) => item.id === filter.alertRule)?.name;
				return filter.alertRule ? `Rule ${named ?? filter.alertRule}` : 'Every alert rule';
			}
		}
	}

	type RuleRow = EventRuleView;
	const ruleColumns: DataColumn<RuleRow>[] = [
		{
			id: 'source',
			header: 'Source',
			value: (row) => `${row.source} ${watching(row)}`,
			cell: sourceCell,
			class: 'pl-4'
		},
		{
			id: 'events',
			header: 'Events',
			value: (row) => row.events.join(' '),
			sortable: false,
			cell: eventsCell,
			class: 'hidden md:table-cell'
		},
		{
			id: 'queue',
			header: 'Queue',
			value: (row) => `${row.broker} ${row.queue}`,
			cell: queueCell,
			class: 'font-mono text-xs'
		},
		{
			id: 'deliveries',
			header: 'Last 24 h',
			value: (row) => row.deliveries.delivered,
			searchable: false,
			descFirst: true,
			cell: countsCell,
			class: 'hidden lg:table-cell'
		},
		{ id: 'actions', header: '', srHeader: 'Actions', cell: ruleActions, class: 'w-0 pr-4' }
	];

	type DeliveryRow = EventDeliveryView;
	const deliveryColumns: DataColumn<DeliveryRow>[] = [
		{
			id: 'type',
			header: 'Event',
			value: (row) => row.type,
			cell: typeCell,
			class: 'pl-4 font-mono text-xs'
		},
		{ id: 'status', header: 'Status', value: (row) => row.status, cell: deliveryStatusCell },
		{
			id: 'rule',
			header: 'Queue',
			value: (row) => ruleById.get(row.ruleId)?.queue ?? '',
			cell: deliveryQueueCell,
			class: 'hidden md:table-cell font-mono text-xs'
		},
		{
			id: 'attempts',
			header: 'Tries',
			value: (row) => row.attempts,
			searchable: false,
			cell: attemptsCell,
			class: 'hidden md:table-cell font-mono text-xs tabular-nums'
		},
		{
			id: 'created',
			header: 'Created',
			value: (row) => row.createdAt,
			searchable: false,
			descFirst: true,
			cell: createdCell,
			class: 'hidden sm:table-cell font-mono text-xs text-muted-foreground'
		},
		{
			id: 'body',
			header: '',
			srHeader: 'Message',
			sortable: false,
			searchable: false,
			cell: bodyCell,
			class: 'pr-4'
		}
	];

	function setView(value: string) {
		const href = resolve('/(dashboard)/events');
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route, only `?view` changes
		void goto(value === 'deliveries' ? `${href}?view=deliveries` : href);
	}

	function remove(rule: EventRuleView) {
		askConfirm({
			title: 'Delete this event rule?',
			description: `${SOURCES[rule.source].label} events (${watching(rule)}) stop going to ${rule.queue}. ${rule.deliveries.pending} undelivered events are dropped; messages already in the queue stay.`,
			confirmLabel: 'Delete rule',
			tone: 'danger',
			action: '?/delete',
			fields: { id: rule.id }
		});
	}

	const deliveryTone = (status: string) =>
		status === 'delivered' ? 'success' : status === 'failed' ? 'danger' : 'warning';
</script>

<svelte:head>
	<title>Events · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		target="page.events"
		eyebrow="Workloads"
		title="Events"
		description="Send platform events to a queue: uploads to a bucket, alerts, deployments and database backups. A function that consumes the queue gets each event in queue()."
	>
		{#if data.can.update && data.enabled}
			<Button onclick={() => (createOpen = true)} disabled={data.brokers.length === 0}>
				<PlusIcon />
				New rule
			</Button>
		{/if}
	</PageHeader>

	{#if !data.enabled}
		<Notice tone="warning" title="Queue brokers are switched off">
			Event rules publish into managed brokers. Set <code class="font-mono"
				>SKIFF_FEATURE_BROKERS=1</code
			> to use them.
		</Notice>
	{/if}

	{#if data.denied}
		<EmptyState
			icon={ShieldAlertIcon}
			title="Events are not visible"
			description="This account does not have the broker:read permission."
		/>
	{:else}
		<Tabs.Root value={tab} onValueChange={setView}>
			<Tabs.List variant="line" class="w-full justify-start border-b" aria-label="Event views">
				<Tabs.Trigger value="rules" class="flex-none">
					<WebhookIcon />
					Rules
					<span class="font-mono text-xs text-muted-foreground">{data.rules.length}</span>
				</Tabs.Trigger>
				<Tabs.Trigger value="deliveries" class="flex-none">
					<SendIcon />
					Deliveries
					<span class="font-mono text-xs text-muted-foreground">{deliveries.length}</span>
				</Tabs.Trigger>
			</Tabs.List>
		</Tabs.Root>

		{#if tab === 'rules'}
			{#if data.rules.length === 0}
				<EmptyState
					icon={WebhookIcon}
					title="No event rules yet"
					description={data.brokers.length === 0
						? 'Rules publish into a queue on a managed broker. Create a broker first, attach it to the function that should handle the events, then add a rule here.'
						: 'Pick a source and a queue. Every matching event becomes a message the consuming function handles in queue(), with the queue’s retries and dead-letter queue.'}
				>
					{#if data.brokers.length === 0}
						<Button href={resolve('/(dashboard)/brokers') + '?new=1'} variant="outline"
							><InboxIcon />Create a broker</Button
						>
					{:else if data.can.update && data.enabled}
						<Button onclick={() => (createOpen = true)}><PlusIcon />Create rule</Button>
					{/if}
				</EmptyState>
			{:else}
				{@render toolbar(
					'Search rules',
					`${data.rules.length} ${data.rules.length === 1 ? 'rule' : 'rules'}`
				)}
				<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
					<DataTable
						label="Event rules"
						rows={data.rules}
						columns={ruleColumns}
						rowId={(row) => row.id}
						search={query.trim()}
						sort={{ id: 'source', desc: false }}
						onmatch={(count) => (matched = count)}
					/>
				</div>
			{/if}
		{:else if deliveries.length === 0}
			<EmptyState
				icon={SendIcon}
				title="No deliveries yet"
				description="Each matching event shows here: pending until the broker's node publishes it, then delivered. Use Send test event on a rule to try one."
			/>
		{:else}
			{#if live.error}
				<Notice tone="warning" title="Live updates paused">{errorText(live.error)}</Notice>
			{/if}
			{@render toolbar(
				'Search deliveries',
				`Newest ${deliveries.length} · refreshes every 5 s · kept 7 days`
			)}
			<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
				<DataTable
					label="Event deliveries"
					rows={deliveries}
					columns={deliveryColumns}
					rowId={(row) => row.id}
					search={query.trim()}
					sort={{ id: 'created', desc: true }}
					onmatch={(count) => (matched = count)}
				/>
			</div>
		{/if}
	{/if}
</div>

{#if data.can.update && data.enabled && data.brokers.length > 0}
	<FormDialog
		bind:open={createOpen}
		icon={WebhookIcon}
		title="New event rule"
		description="Matching events are published as messages to a queue on a managed broker."
		action="?/create"
		submitLabel="Create rule"
		size="lg"
	>
		<Field.Group>
			<Field.Field>
				<Field.Label for="event-source">Source</Field.Label>
				<NativeSelect.Root id="event-source" name="source" bind:value={source} class="w-full">
					{#each data.sources as item (item.source)}
						<NativeSelect.Option value={item.source}
							>{SOURCES[item.source].label} — {SOURCES[item.source].blurb}</NativeSelect.Option
						>
					{/each}
				</NativeSelect.Root>
			</Field.Field>

			{#if source === 'storage'}
				{#if data.storage.length === 0}
					<Notice tone="warning" title="No storage instances"
						>Create a storage instance with a bucket first.</Notice
					>
				{:else}
					<div class="grid gap-4 sm:grid-cols-2">
						<Field.Field data-invalid={errors.storage ? true : undefined}>
							<Field.Label for="event-storage">Storage instance</Field.Label>
							<NativeSelect.Root
								id="event-storage"
								name="storage"
								bind:value={storageName}
								class="w-full"
							>
								{#each data.storage as item (item.name)}
									<NativeSelect.Option value={item.name}>{item.name}</NativeSelect.Option>
								{/each}
							</NativeSelect.Root>
							{#if errors.storage}<Field.Error>{errors.storage}</Field.Error>{/if}
						</Field.Field>
						<Field.Field data-invalid={errors.bucket ? true : undefined}>
							<Field.Label for="event-bucket">Bucket</Field.Label>
							<NativeSelect.Root id="event-bucket" name="bucket" class="w-full">
								{#each buckets as bucket (bucket)}
									<NativeSelect.Option value={bucket}>{bucket}</NativeSelect.Option>
								{/each}
							</NativeSelect.Root>
							{#if errors.bucket}<Field.Error>{errors.bucket}</Field.Error>{/if}
						</Field.Field>
					</div>
					<div class="grid gap-4 sm:grid-cols-2">
						<Field.Field>
							<Field.Label for="event-prefix"
								>Key prefix <span class="font-normal text-muted-foreground">optional</span
								></Field.Label
							>
							<Input
								id="event-prefix"
								name="prefix"
								placeholder="uploads/"
								maxlength={1024}
								spellcheck="false"
								class="font-mono text-sm"
							/>
						</Field.Field>
						<Field.Field>
							<Field.Label for="event-suffix"
								>Key suffix <span class="font-normal text-muted-foreground">optional</span
								></Field.Label
							>
							<Input
								id="event-suffix"
								name="suffix"
								placeholder=".jpg"
								maxlength={1024}
								spellcheck="false"
								class="font-mono text-sm"
							/>
						</Field.Field>
					</div>
					<p class="text-xs text-muted-foreground">
						Messages use Cloudflare's R2 notification body, so an R2 consumer runs unchanged. The
						instance restarts once to switch notifications on.
					</p>
				{/if}
			{:else if source === 'deployments'}
				<Field.Field>
					<Field.Label for="event-project">Project</Field.Label>
					<NativeSelect.Root id="event-project" name="project" class="w-full">
						<NativeSelect.Option value="">Every project</NativeSelect.Option>
						{#each data.projects as project (project.slug)}
							<NativeSelect.Option value={project.slug}>{project.name}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
			{:else if source === 'database-backups'}
				<Field.Field>
					<Field.Label for="event-database">Database</Field.Label>
					<NativeSelect.Root id="event-database" name="database" class="w-full">
						<NativeSelect.Option value="">Every database</NativeSelect.Option>
						{#each data.databases as name (name)}
							<NativeSelect.Option value={name}>{name}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
			{:else if source === 'alerts'}
				<Field.Field>
					<Field.Label for="event-alert">Alert rule</Field.Label>
					<NativeSelect.Root id="event-alert" name="alertRule" class="w-full">
						<NativeSelect.Option value="">Every alert rule</NativeSelect.Option>
						{#each data.alertRules as rule (rule.id)}
							<NativeSelect.Option value={rule.id}>{rule.name}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
					<Field.Description
						>An event is sent whenever the rule notifies, so silences and repeat settings apply.</Field.Description
					>
				</Field.Field>
			{/if}

			<Field.Set data-invalid={errors.events ? true : undefined}>
				<Field.Legend variant="label">Events</Field.Legend>
				<div class="flex flex-wrap gap-x-5 gap-y-2">
					{#each sourceEvents as event (`${source}:${event}`)}
						<label class="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								name="events"
								value={event}
								checked
								class="size-4 accent-primary"
							/>
							{EVENT_LABELS[event] ?? event}
						</label>
					{/each}
				</div>
				{#if errors.events}<Field.Error>{errors.events}</Field.Error>{/if}
			</Field.Set>

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.broker ? true : undefined}>
					<Field.Label for="event-broker">Broker</Field.Label>
					<NativeSelect.Root id="event-broker" name="broker" bind:value={broker} class="w-full">
						{#each data.brokers as item (item.name)}
							<NativeSelect.Option value={item.name}>{item.name}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
					{#if errors.broker}<Field.Error>{errors.broker}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.queue ? true : undefined}>
					<Field.Label for="event-queue">Queue</Field.Label>
					<Input
						id="event-queue"
						name="queue"
						bind:value={queueName}
						placeholder="images"
						required
						maxlength={63}
						pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
						autocapitalize="off"
						spellcheck="false"
						class="font-mono text-sm"
						aria-invalid={errors.queue ? 'true' : undefined}
					/>
					{#if errors.queue}<Field.Error>{errors.queue}</Field.Error>{/if}
				</Field.Field>
			</div>
			<div class="space-y-1.5 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
				<p>
					Consume it from a function: attach <span class="font-mono">{broker || 'the broker'}</span>
					to the function project{#if data.brokers.find((item) => item.name === broker)?.attachments.length}
						(attached to <span class="font-mono"
							>{data.brokers.find((item) => item.name === broker)?.attachments.join(', ')}</span
						>){/if}, then add to <span class="font-mono">wrangler.jsonc</span>:
				</p>
				<div class="flex items-center gap-2">
					<code class="min-w-0 flex-1 truncate font-mono text-foreground">{consumerSnippet}</code>
					<CopyButton value={consumerSnippet} label="Copy consumer config" />
				</div>
			</div>

			<Field.Field>
				<Field.Label for="event-description"
					>Description <span class="font-normal text-muted-foreground">optional</span></Field.Label
				>
				<Input
					id="event-description"
					name="description"
					maxlength={200}
					placeholder="Resize new photos"
				/>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

{#snippet toolbar(placeholder: string, summary: string)}
	<div class="flex flex-wrap items-center justify-between gap-3">
		<InputGroup.Root class="max-w-xs bg-card">
			<InputGroup.Input {placeholder} bind:value={query} aria-label={placeholder} />
			<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
			{#if query}
				<InputGroup.Addon align="inline-end">
					<InputGroup.Text class="font-mono text-xs">{matched}</InputGroup.Text>
				</InputGroup.Addon>
			{/if}
		</InputGroup.Root>
		<p class="text-sm text-muted-foreground">{summary}</p>
	</div>
{/snippet}

{#snippet sourceCell(rule: RuleRow)}
	{@const meta = SOURCES[rule.source]}
	<div class="flex items-center gap-3">
		<span
			class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
		>
			<meta.icon class="size-4" />
		</span>
		<div class="min-w-0">
			<p class="flex items-center gap-2 text-sm font-medium">
				{meta.label}
				{#if !rule.enabled}<Badge variant="outline" class="font-normal">Disabled</Badge>{/if}
			</p>
			<p
				class="truncate font-mono text-xs text-muted-foreground"
				title={rule.description ?? undefined}
			>
				{watching(rule)}
			</p>
		</div>
	</div>
{/snippet}

{#snippet eventsCell(rule: RuleRow)}
	<div class="flex flex-wrap gap-1.5">
		{#each rule.events as event (event)}
			<Badge variant="secondary" class="font-normal">{EVENT_LABELS[event] ?? event}</Badge>
		{/each}
	</div>
{/snippet}

{#snippet queueCell(rule: RuleRow)}
	<a
		href={resolve('/(dashboard)/brokers/[name]', { name: rule.broker })}
		class="underline-offset-4 hover:underline"
	>
		{rule.broker}</a
	><span class="text-muted-foreground"> / </span>{rule.queue}
{/snippet}

{#snippet countsCell(rule: RuleRow)}
	<div class="space-y-0.5 text-xs">
		<p class="font-mono tabular-nums">
			{rule.deliveries.delivered} delivered{#if rule.deliveries.pending}
				<span class="text-warning">
					· {rule.deliveries.pending} waiting</span
				>{/if}{#if rule.deliveries.failed}
				<span class="text-destructive"> · {rule.deliveries.failed} failed</span>{/if}
		</p>
		{#if rule.lastError}
			<p class="max-w-64 truncate text-destructive" title={rule.lastError}>{rule.lastError}</p>
		{:else if rule.lastDeliveredAt}
			<p class="text-muted-foreground">
				Last <time datetime={rule.lastDeliveredAt}>{formatDate(rule.lastDeliveredAt)}</time>
			</p>
		{/if}
	</div>
{/snippet}

{#snippet ruleActions(rule: RuleRow)}
	{#if data.can.update}
		<RowMenu label="Actions for this rule">
			<DropdownMenu.Item onSelect={() => void runAction('?/test', { id: rule.id })}>
				<SendIcon />Send test event
			</DropdownMenu.Item>
			<DropdownMenu.Item
				onSelect={() => void runAction('?/toggle', { id: rule.id, enabled: String(!rule.enabled) })}
			>
				<PowerIcon />{rule.enabled ? 'Disable' : 'Enable'}
			</DropdownMenu.Item>
			<DropdownMenu.Separator />
			<DropdownMenu.Item variant="destructive" onSelect={() => remove(rule)}>
				<Trash2Icon />Delete
			</DropdownMenu.Item>
		</RowMenu>
	{/if}
{/snippet}

{#snippet typeCell(delivery: DeliveryRow)}
	{delivery.type}
{/snippet}

{#snippet deliveryStatusCell(delivery: DeliveryRow)}
	<div class="space-y-1">
		<StatusBadge status={delivery.status} tone={deliveryTone(delivery.status)} />
		{#if delivery.lastError}
			<p class="max-w-64 truncate text-xs text-muted-foreground" title={delivery.lastError}>
				{delivery.lastError}
			</p>
		{/if}
	</div>
{/snippet}

{#snippet deliveryQueueCell(delivery: DeliveryRow)}
	{@const rule = ruleById.get(delivery.ruleId)}
	{#if rule}{rule.broker}<span class="text-muted-foreground"> / </span>{rule.queue}{:else}<span
			class="text-muted-foreground">deleted rule</span
		>{/if}
{/snippet}

{#snippet attemptsCell(delivery: DeliveryRow)}
	{delivery.attempts}
{/snippet}

{#snippet createdCell(delivery: DeliveryRow)}
	<time datetime={delivery.createdAt}>{formatDate(delivery.createdAt)}</time>
{/snippet}

{#snippet bodyCell(delivery: DeliveryRow)}
	<details class="group text-xs">
		<summary class="cursor-pointer text-muted-foreground select-none hover:text-foreground"
			>Message</summary
		>
		<pre
			class="mt-2 max-h-64 max-w-[min(36rem,70vw)] overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed">{JSON.stringify(
				delivery.body,
				null,
				2
			)}</pre>
	</details>
{/snippet}

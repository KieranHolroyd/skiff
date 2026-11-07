<script lang="ts">
	import { resolve } from '$app/paths';
	import BellIcon from '@lucide/svelte/icons/bell';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CylinderIcon from '@lucide/svelte/icons/cylinder';
	import DatabaseBackupIcon from '@lucide/svelte/icons/database-backup';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PowerIcon from '@lucide/svelte/icons/power';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import SendIcon from '@lucide/svelte/icons/send';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import WebhookIcon from '@lucide/svelte/icons/webhook';
	import type { EventSource } from '@skiff/contracts';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import { formatDate } from '../../_lib/format.js';
	import type { FunctionEventSourcesData } from './event-sources.server.js';
	import { consumerSnippet, queueKey, type FunctionEventSource } from './event-sources.js';

	/**
	 * A function's event sources (docs/EVENTS.md, D122). Platform events reach a function only through
	 * a queue it consumes, so the rules that publish them are set up here, next to its triggers.
	 */
	let {
		slug,
		data,
		fieldErrors = {}
	}: {
		slug: string;
		data: FunctionEventSourcesData;
		fieldErrors?: Record<string, string>;
	} = $props();

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
	const NEW_QUEUE = '__new';

	let createOpen = $state(false);
	let deliveriesOpen = $state(false);
	let source = $state<EventSource>('storage');
	let storageName = $state('');
	let target = $state('');
	let broker = $state('');
	let queueName = $state('');

	const canAdd = $derived(
		data.can.update && (data.consumers.length > 0 || data.attachedBrokers.length > 0)
	);
	const sourceEvents = $derived(data.sources.find((item) => item.source === source)?.events ?? []);
	const buckets = $derived(data.storage.find((item) => item.name === storageName)?.buckets ?? []);
	/** A queue the function doesn't consume yet: pick an attached broker and name the queue. */
	const newQueue = $derived(data.consumers.length === 0 || target === NEW_QUEUE);
	const ruleById = $derived(new Map(data.rules.map((rule) => [rule.id, rule])));

	$effect(() => {
		if (!storageName && data.storage[0]) storageName = data.storage[0].name;
		if (!target && data.consumers[0]) target = queueKey(data.consumers[0]);
		if (!broker && data.attachedBrokers[0]) broker = data.attachedBrokers[0];
	});

	function watching(rule: FunctionEventSource): string {
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

	function remove(rule: FunctionEventSource) {
		askConfirm({
			title: 'Remove this event source?',
			description: `${SOURCES[rule.source].label} events (${watching(rule)}) stop going to ${rule.queue}. ${rule.deliveries.pending} undelivered events are dropped; messages already in the queue stay.`,
			confirmLabel: 'Remove',
			tone: 'danger',
			action: '?/deleteEventSource',
			fields: { id: rule.id }
		});
	}

	const deliveryTone = (status: string) =>
		status === 'delivered' ? 'success' : status === 'failed' ? 'danger' : 'warning';
</script>

<Card.Root class="gap-0 py-0">
	<Card.Header class="border-b py-4">
		<Card.Title class="flex items-center gap-2">
			<WebhookIcon class="size-4 text-muted-foreground" />
			Event sources
			{#if data.rules.length > 0}
				<Badge variant="neutral" class="tabular-nums">{data.rules.length}</Badge>
			{/if}
		</Card.Title>
		<Card.Description>
			Platform events (bucket uploads, alerts, deployments, database backups) published into a queue
			this function consumes. Each one arrives in <code class="font-mono text-xs">queue()</code> with
			the queue's retries and dead-letter queue.
		</Card.Description>
		{#if data.enabled && canAdd}
			<Card.Action class="self-center">
				<Button size="sm" variant="outline" onclick={() => (createOpen = true)}>
					<PlusIcon />Add event source
				</Button>
			</Card.Action>
		{/if}
	</Card.Header>
	<Card.Content class="px-0 py-0">
		{#if !data.enabled}
			<p class="px-6 py-4 text-sm text-muted-foreground">
				Event sources publish into managed queue brokers, which are switched off. Set
				<code class="font-mono text-xs">SKIFF_FEATURE_BROKERS=1</code> to use them.
			</p>
		{:else if !data.readable}
			<p class="px-6 py-4 text-sm text-muted-foreground">
				This account does not have the <code class="font-mono text-xs">broker:read</code> permission.
			</p>
		{:else if data.rules.length === 0}
			<div class="space-y-3 px-6 py-4 text-sm text-muted-foreground">
				{#if data.consumers.length === 0 && data.attachedBrokers.length === 0}
					<p>
						Events reach a function through a queue. Attach a broker to {slug}, add a queue consumer
						to <code class="font-mono text-xs">wrangler.jsonc</code>, then add an event source here.
					</p>
					<Button href={resolve('/(dashboard)/brokers')} variant="outline" size="sm">
						<InboxIcon />Queues
					</Button>
				{:else}
					<p>
						No event sources yet. Add one to send matching events to
						{data.consumers.length > 0
							? data.consumers.map((item) => item.queue).join(', ')
							: 'a queue on ' + data.attachedBrokers.join(', ')}.
					</p>
				{/if}
			</div>
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-6">Source</Table.Head>
						<Table.Head class="hidden md:table-cell">Events</Table.Head>
						<Table.Head>Queue</Table.Head>
						<Table.Head class="hidden lg:table-cell">Last 24 h</Table.Head>
						<Table.Head class="w-0 pr-6"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.rules as rule (rule.id)}
						{@const meta = SOURCES[rule.source]}
						<Table.Row>
							<Table.Cell class="pl-6">
								<div class="flex items-center gap-3">
									<span
										class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
									>
										<meta.icon class="size-4" />
									</span>
									<div class="min-w-0">
										<p class="flex items-center gap-2 text-sm font-medium">
											{meta.label}
											{#if !rule.enabled}<Badge variant="outline" class="font-normal">Paused</Badge
												>{/if}
										</p>
										<p
											class="max-w-64 truncate font-mono text-xs text-muted-foreground"
											title={rule.description ?? undefined}
										>
											{watching(rule)}
										</p>
									</div>
								</div>
							</Table.Cell>
							<Table.Cell class="hidden md:table-cell">
								<div class="flex flex-wrap gap-1.5">
									{#each rule.events as event (event)}
										<Badge variant="secondary" class="font-normal"
											>{EVENT_LABELS[event] ?? event}</Badge
										>
									{/each}
								</div>
							</Table.Cell>
							<Table.Cell class="font-mono text-xs">
								<a
									href={resolve('/(dashboard)/brokers/[name]', { name: rule.broker })}
									class="underline-offset-4 hover:underline">{rule.broker}</a
								><span class="text-muted-foreground"> / </span>{rule.queue}
								{#if !rule.consumed}
									<Badge
										variant="warning"
										class="ml-1 font-sans"
										title="Add {consumerSnippet(rule.queue)} to wrangler.jsonc and deploy"
										>not consumed</Badge
									>
								{/if}
							</Table.Cell>
							<Table.Cell class="hidden text-xs lg:table-cell">
								<p class="font-mono tabular-nums">
									{rule.deliveries.delivered} delivered{#if rule.deliveries.pending}
										<span class="text-warning">
											· {rule.deliveries.pending} waiting</span
										>{/if}{#if rule.deliveries.failed}
										<span class="text-destructive"> · {rule.deliveries.failed} failed</span>{/if}
								</p>
								{#if rule.lastError}
									<p class="max-w-64 truncate text-destructive" title={rule.lastError}>
										{rule.lastError}
									</p>
								{:else if rule.lastDeliveredAt}
									<p class="text-muted-foreground">
										Last <time datetime={rule.lastDeliveredAt}
											>{formatDate(rule.lastDeliveredAt)}</time
										>
									</p>
								{/if}
							</Table.Cell>
							<Table.Cell class="pr-6">
								{#if data.can.update}
									<RowMenu label="Actions for this event source">
										<DropdownMenu.Item
											onSelect={() => void runAction('?/testEventSource', { id: rule.id })}
										>
											<SendIcon />Send test event
										</DropdownMenu.Item>
										<DropdownMenu.Item
											onSelect={() =>
												void runAction('?/toggleEventSource', {
													id: rule.id,
													enabled: String(!rule.enabled)
												})}
										>
											<PowerIcon />{rule.enabled ? 'Pause' : 'Resume'}
										</DropdownMenu.Item>
										<DropdownMenu.Separator />
										<DropdownMenu.Item variant="destructive" onSelect={() => remove(rule)}>
											<Trash2Icon />Remove
										</DropdownMenu.Item>
									</RowMenu>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>

			<Collapsible.Root bind:open={deliveriesOpen} class="border-t">
				<Collapsible.Trigger
					class="flex w-full items-center justify-between px-6 py-3 text-left text-sm font-medium"
				>
					<span class="flex items-center gap-2">
						<SendIcon class="size-4 text-muted-foreground" />
						Recent deliveries
						<span class="font-mono text-xs text-muted-foreground">{data.deliveries.length}</span>
					</span>
					<ChevronDownIcon
						class="size-4 text-muted-foreground transition-transform {deliveriesOpen
							? 'rotate-180'
							: ''}"
					/>
				</Collapsible.Trigger>
				<Collapsible.Content>
					{#if data.deliveries.length === 0}
						<p class="px-6 pb-4 text-xs text-muted-foreground">
							Nothing delivered yet. Each matching event shows here: pending until the broker's node
							publishes it, then delivered. Use Send test event to try one.
						</p>
					{:else}
						<Table.Root>
							<Table.Header class="bg-muted/45">
								<Table.Row>
									<Table.Head class="pl-6">Event</Table.Head>
									<Table.Head>Status</Table.Head>
									<Table.Head class="hidden md:table-cell">Queue</Table.Head>
									<Table.Head class="hidden sm:table-cell">Created</Table.Head>
									<Table.Head class="pr-6"><span class="sr-only">Message</span></Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each data.deliveries as delivery (delivery.id)}
									{@const rule = ruleById.get(delivery.ruleId)}
									<Table.Row>
										<Table.Cell class="pl-6 font-mono text-xs">{delivery.type}</Table.Cell>
										<Table.Cell>
											<div class="space-y-1">
												<StatusBadge
													status={delivery.status}
													tone={deliveryTone(delivery.status)}
												/>
												{#if delivery.lastError}
													<p
														class="max-w-64 truncate text-xs text-muted-foreground"
														title={delivery.lastError}
													>
														{delivery.lastError}
													</p>
												{/if}
											</div>
										</Table.Cell>
										<Table.Cell class="hidden font-mono text-xs md:table-cell">
											{rule?.queue ?? '—'}
											{#if delivery.attempts > 1}<span class="text-muted-foreground">
													· {delivery.attempts} tries</span
												>{/if}
										</Table.Cell>
										<Table.Cell
											class="hidden font-mono text-xs text-muted-foreground sm:table-cell"
										>
											<time datetime={delivery.createdAt}>{formatDate(delivery.createdAt)}</time>
										</Table.Cell>
										<Table.Cell class="pr-6">
											<details class="text-xs">
												<summary
													class="cursor-pointer text-muted-foreground select-none hover:text-foreground"
													>Message</summary
												>
												<pre
													class="mt-2 max-h-64 max-w-[min(36rem,70vw)] overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed">{JSON.stringify(
														delivery.body,
														null,
														2
													)}</pre>
											</details>
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					{/if}
				</Collapsible.Content>
			</Collapsible.Root>
		{/if}
	</Card.Content>
</Card.Root>

{#if data.enabled && canAdd}
	<FormDialog
		bind:open={createOpen}
		icon={WebhookIcon}
		title="Add event source"
		description="Matching events are published to a queue {slug} consumes and handled in queue()."
		action="?/createEventSource"
		submitLabel="Add event source"
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
						<Field.Field data-invalid={fieldErrors.storage ? true : undefined}>
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
							{#if fieldErrors.storage}<Field.Error>{fieldErrors.storage}</Field.Error>{/if}
						</Field.Field>
						<Field.Field data-invalid={fieldErrors.bucket ? true : undefined}>
							<Field.Label for="event-bucket">Bucket</Field.Label>
							<NativeSelect.Root id="event-bucket" name="bucket" class="w-full">
								{#each buckets as bucket (bucket)}
									<NativeSelect.Option value={bucket}>{bucket}</NativeSelect.Option>
								{/each}
							</NativeSelect.Root>
							{#if fieldErrors.bucket}<Field.Error>{fieldErrors.bucket}</Field.Error>{/if}
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

			<Field.Set data-invalid={fieldErrors.events ? true : undefined}>
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
				{#if fieldErrors.events}<Field.Error>{fieldErrors.events}</Field.Error>{/if}
			</Field.Set>

			{#if data.consumers.length > 0}
				<Field.Field>
					<Field.Label for="event-target">Deliver to</Field.Label>
					<NativeSelect.Root id="event-target" name="target" bind:value={target} class="w-full">
						{#each data.consumers as consumer (queueKey(consumer))}
							<NativeSelect.Option value={queueKey(consumer)}
								>{consumer.queue} · {consumer.broker}</NativeSelect.Option
							>
						{/each}
						{#if data.attachedBrokers.length > 0}
							<NativeSelect.Option value={NEW_QUEUE}>Another queue…</NativeSelect.Option>
						{/if}
					</NativeSelect.Root>
					<Field.Description>The queues {slug} consumes, from its wrangler.jsonc.</Field.Description
					>
				</Field.Field>
			{/if}

			{#if newQueue}
				<div class="grid gap-4 sm:grid-cols-2">
					<Field.Field data-invalid={fieldErrors.broker ? true : undefined}>
						<Field.Label for="event-broker">Broker</Field.Label>
						<NativeSelect.Root id="event-broker" name="broker" bind:value={broker} class="w-full">
							{#each data.attachedBrokers as name (name)}
								<NativeSelect.Option value={name}>{name}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
						{#if fieldErrors.broker}<Field.Error>{fieldErrors.broker}</Field.Error>{/if}
					</Field.Field>
					<Field.Field data-invalid={fieldErrors.queue ? true : undefined}>
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
							aria-invalid={fieldErrors.queue ? 'true' : undefined}
						/>
						{#if fieldErrors.queue}<Field.Error>{fieldErrors.queue}</Field.Error>{/if}
					</Field.Field>
				</div>
				<div class="space-y-1.5 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
					<p>
						{slug} doesn't consume this queue yet. Add to
						<span class="font-mono">wrangler.jsonc</span> and deploy:
					</p>
					<div class="flex items-center gap-2">
						<code class="min-w-0 flex-1 truncate font-mono text-foreground"
							>{consumerSnippet(queueName)}</code
						>
						<CopyButton value={consumerSnippet(queueName)} label="Copy consumer config" />
					</div>
				</div>
			{/if}

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

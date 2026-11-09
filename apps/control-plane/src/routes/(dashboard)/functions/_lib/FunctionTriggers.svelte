<script lang="ts">
	import BellIcon from '@lucide/svelte/icons/bell';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import CylinderIcon from '@lucide/svelte/icons/cylinder';
	import DatabaseBackupIcon from '@lucide/svelte/icons/database-backup';
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PowerIcon from '@lucide/svelte/icons/power';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import PackageIcon from '@lucide/svelte/icons/package';
	import SendIcon from '@lucide/svelte/icons/send';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import type { ProjectView } from '@yoal/core';
	import type { EventSource, FunctionView } from '@yoal/contracts';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import { formatDate, formatDateTime } from '../../_lib/format.js';
	import { describeCron } from '../../_lib/function-view.js';
	import type { FunctionEventTriggersData } from './event-triggers.server.js';
	import { consumerSnippet, queueKey, type FunctionEventTrigger } from './event-triggers.js';

	/**
	 * Everything that runs a function: HTTP requests, cron schedules, queue batches, and platform
	 * events (docs/EVENTS.md, D122). Cron and queue triggers come from `wrangler.jsonc`; event
	 * triggers are rules that publish into one of the function's queues, so they are added here.
	 */
	let {
		project,
		view,
		cronNext,
		events,
		fieldErrors = {}
	}: {
		project: ProjectView;
		view: FunctionView;
		/** Next fire time per cron expression, computed on the server (UTC). */
		cronNext: Record<string, string | null>;
		events: FunctionEventTriggersData;
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
		},
		registry: {
			label: 'Registry',
			icon: PackageIcon,
			blurb: 'An image pushed to the platform registry'
		},
		pools: {
			label: 'User pools',
			icon: FingerprintIcon,
			blurb: 'A pool user signing up or signing in'
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
		completed: 'Completed',
		'user.created': 'User created',
		'user.signed_in': 'User signed in',
		'user.deleted': 'User deleted',
		'mfa.enabled': 'MFA enabled'
	};
	const NEW_QUEUE = '__new';

	let createOpen = $state(false);
	let deliveriesOpen = $state(false);
	let source = $state<EventSource>('storage');
	let storageName = $state('');
	let target = $state('');
	let broker = $state('');
	let queueName = $state('');

	/** An event trigger needs a queue: one the function consumes, or one on an attached broker. */
	const canAdd = $derived(
		events.enabled &&
			events.can.update &&
			(events.consumers.length > 0 || events.attachedBrokers.length > 0)
	);
	const sourceEvents = $derived(
		events.sources.find((item) => item.source === source)?.events ?? []
	);
	const buckets = $derived(events.storage.find((item) => item.name === storageName)?.buckets ?? []);
	const newQueue = $derived(events.consumers.length === 0 || target === NEW_QUEUE);
	const ruleById = $derived(new Map(events.rules.map((rule) => [rule.id, rule])));

	$effect(() => {
		if (!storageName && events.storage[0]) storageName = events.storage[0].name;
		if (!target && events.consumers[0]) target = queueKey(events.consumers[0]);
		if (!broker && events.attachedBrokers[0]) broker = events.attachedBrokers[0];
	});

	function watching(rule: FunctionEventTrigger): string {
		const filter = rule.filter;
		switch (rule.source) {
			case 'storage': {
				const keys =
					filter.prefix || filter.suffix ? ` · ${filter.prefix ?? ''}*${filter.suffix ?? ''}` : '';
				return `${filter.storage}/${filter.bucket}${keys}`;
			}
			case 'deployments':
				return filter.project ? `project ${filter.project}` : 'every project';
			case 'database-backups':
				return filter.database ? `database ${filter.database}` : 'every database';
			case 'registry':
				return filter.repository ? `repository ${filter.repository}` : 'every repository';
			case 'alerts': {
				const named = events.alertRules.find((item) => item.id === filter.alertRule)?.name;
				return filter.alertRule ? `rule ${named ?? filter.alertRule}` : 'every alert rule';
			}
			case 'pools':
				return filter.pool ? `pool ${filter.pool}` : 'every pool';
		}
	}

	function remove(rule: FunctionEventTrigger) {
		askConfirm({
			title: 'Remove this event trigger?',
			description: `${SOURCES[rule.source].label} events (${watching(rule)}) stop going to ${rule.queue}. ${rule.deliveries.pending} undelivered events are dropped; messages already in the queue stay.`,
			confirmLabel: 'Remove trigger',
			tone: 'danger',
			action: '?/deleteEventTrigger',
			fields: { id: rule.id }
		});
	}

	const deliveryTone = (status: string) =>
		status === 'delivered' ? 'success' : status === 'failed' ? 'danger' : 'warning';
</script>

<Card.Root class="gap-0 py-0">
	<Card.Header class="border-b py-4">
		<Card.Title class="flex items-center gap-2">
			<ZapIcon class="size-4 text-muted-foreground" />
			Triggers
		</Card.Title>
		<Card.Description>
			What runs the function. Cron and queue triggers come from <code class="font-mono text-xs"
				>wrangler.jsonc</code
			>; event triggers publish platform events into one of its queues, handled in
			<code class="font-mono text-xs">queue()</code>.
		</Card.Description>
		{#if canAdd}
			<Card.Action class="self-center">
				<Button size="sm" variant="outline" onclick={() => (createOpen = true)}>
					<PlusIcon />Add trigger
				</Button>
			</Card.Action>
		{/if}
	</Card.Header>
	<Card.Content class="px-0 py-0">
		<ul class="divide-y">
			<li class="flex items-start gap-3 px-6 py-3">
				{@render kind(GlobeIcon)}
				<div class="min-w-0 flex-1 text-sm">
					<p class="font-medium">HTTP <span class="font-mono text-xs">fetch()</span></p>
					<p class="truncate text-xs text-muted-foreground" title={project.productionUrl}>
						{project.productionUrl}, previews and custom domains
					</p>
				</div>
			</li>

			{#each view.triggers.crons as cron (cron)}
				{@const described = describeCron(cron)}
				{@const next = cronNext[cron]}
				<li class="flex items-start gap-3 px-6 py-3">
					{@render kind(ClockIcon)}
					<div class="min-w-0 flex-1 text-sm">
						<p class="font-medium">
							Cron <span class="font-mono text-xs">{cron}</span>
						</p>
						<p class="text-xs text-muted-foreground">
							{described ?? 'scheduled()'} · UTC
						</p>
					</div>
					{#if next}
						<p class="hidden shrink-0 text-xs text-muted-foreground sm:block">
							Next <time datetime={next} title={formatDateTime(next)}>{formatDateTime(next)}</time>
						</p>
					{/if}
				</li>
			{/each}

			{#each view.triggers.queues as consumer (queueKey(consumer))}
				<li class="flex items-start gap-3 px-6 py-3">
					{@render kind(InboxIcon)}
					<div class="min-w-0 flex-1 text-sm">
						<p class="font-medium">
							Queue <span class="font-mono text-xs">{consumer.queue}</span>
						</p>
						<p class="text-xs text-muted-foreground">on {consumer.broker} · queue()</p>
					</div>
				</li>
			{/each}

			{#each events.rules as rule (rule.id)}
				{@const meta = SOURCES[rule.source]}
				<li class="flex items-start gap-3 px-6 py-3">
					{@render kind(meta.icon)}
					<div class="min-w-0 flex-1 space-y-1 text-sm">
						<p class="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
							{meta.label} event
							{#each rule.events as event (event)}
								<Badge variant="secondary" class="font-normal">{EVENT_LABELS[event] ?? event}</Badge
								>
							{/each}
							{#if !rule.enabled}<Badge variant="outline" class="font-normal">Paused</Badge>{/if}
							{#if !rule.consumed}
								<Badge
									variant="warning"
									class="font-normal"
									title="Add {consumerSnippet(rule.queue)} to wrangler.jsonc and deploy"
									>queue not consumed</Badge
								>
							{/if}
						</p>
						<p
							class="truncate font-mono text-xs text-muted-foreground"
							title={rule.description ?? undefined}
						>
							{watching(rule)} → {rule.queue}
						</p>
						{#if rule.lastError}
							<p class="truncate text-xs text-destructive" title={rule.lastError}>
								{rule.lastError}
							</p>
						{/if}
					</div>
					<div class="hidden shrink-0 text-right text-xs sm:block">
						<p class="font-mono tabular-nums">
							{rule.deliveries.delivered} delivered · 24 h
						</p>
						{#if rule.deliveries.pending || rule.deliveries.failed}
							<p class="font-mono tabular-nums">
								{#if rule.deliveries.pending}<span class="text-warning"
										>{rule.deliveries.pending} waiting</span
									>{/if}{#if rule.deliveries.pending && rule.deliveries.failed}
									·
								{/if}{#if rule.deliveries.failed}<span class="text-destructive"
										>{rule.deliveries.failed} failed</span
									>{/if}
							</p>
						{:else if rule.lastDeliveredAt}
							<p class="text-muted-foreground">
								Last <time datetime={rule.lastDeliveredAt}>{formatDate(rule.lastDeliveredAt)}</time>
							</p>
						{/if}
					</div>
					{#if events.can.update}
						<RowMenu label="Actions for this event trigger">
							<DropdownMenu.Item
								onSelect={() => void runAction('?/testEventTrigger', { id: rule.id })}
							>
								<SendIcon />Send test event
							</DropdownMenu.Item>
							<DropdownMenu.Item
								onSelect={() =>
									void runAction('?/toggleEventTrigger', {
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
				</li>
			{/each}
		</ul>

		{#if view.triggers.crons.length === 0 || (events.enabled && events.rules.length === 0)}
			<div class="space-y-1 border-t px-6 py-3 text-xs text-muted-foreground">
				{#if view.triggers.crons.length === 0}
					<p>
						No cron triggers. Add <code class="font-mono">triggers.crons</code> to wrangler.jsonc
						and export <code class="font-mono">scheduled()</code>; each schedule fires once per
						occurrence from the function's node.
					</p>
				{/if}
				{#if events.enabled && events.rules.length === 0}
					{#if !events.readable}
						<p>
							Event triggers need the <code class="font-mono">broker:read</code> permission.
						</p>
					{:else if events.consumers.length === 0 && events.attachedBrokers.length === 0}
						<p>
							No event triggers. Events arrive through a queue: attach a broker to {project.slug} under
							Queues, then add an event trigger for bucket uploads, alerts, deployments or database backups.
						</p>
					{:else}
						<p>
							No event triggers. Add one to send bucket uploads, alerts, deployments or database
							backups to {project.slug}.
						</p>
					{/if}
				{/if}
			</div>
		{/if}

		{#if events.rules.length > 0}
			<Collapsible.Root bind:open={deliveriesOpen} class="border-t">
				<Collapsible.Trigger
					class="flex w-full items-center justify-between px-6 py-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
				>
					<span class="flex items-center gap-2">
						<SendIcon class="size-3.5" />
						Recent event deliveries
						<span class="font-mono">{events.deliveries.length}</span>
					</span>
					<ChevronDownIcon
						class="size-4 transition-transform {deliveriesOpen ? 'rotate-180' : ''}"
					/>
				</Collapsible.Trigger>
				<Collapsible.Content>
					{#if events.deliveries.length === 0}
						<p class="px-6 pb-4 text-xs text-muted-foreground">
							Nothing delivered yet. Each matching event shows here: pending until the broker's node
							publishes it, then delivered. Use Send test event to try one.
						</p>
					{:else}
						<ul class="divide-y border-t">
							{#each events.deliveries as delivery (delivery.id)}
								<li class="space-y-1 px-6 py-2.5 text-xs">
									<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
										<span class="font-mono">{delivery.type}</span>
										<StatusBadge status={delivery.status} tone={deliveryTone(delivery.status)} />
										<span class="font-mono text-muted-foreground"
											>→ {ruleById.get(delivery.ruleId)?.queue ??
												'removed trigger'}{#if delivery.attempts > 1}
												· {delivery.attempts} tries{/if}</span
										>
										<time
											class="ml-auto font-mono text-muted-foreground"
											datetime={delivery.createdAt}>{formatDate(delivery.createdAt)}</time
										>
									</div>
									{#if delivery.lastError}
										<p class="truncate text-muted-foreground" title={delivery.lastError}>
											{delivery.lastError}
										</p>
									{/if}
									<details>
										<summary
											class="cursor-pointer text-muted-foreground select-none hover:text-foreground"
											>Message</summary
										>
										<pre
											class="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed">{JSON.stringify(
												delivery.body,
												null,
												2
											)}</pre>
									</details>
								</li>
							{/each}
						</ul>
					{/if}
				</Collapsible.Content>
			</Collapsible.Root>
		{/if}
	</Card.Content>
</Card.Root>

{#snippet kind(Icon: typeof BellIcon)}
	<span
		class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
	>
		<Icon class="size-4" />
	</span>
{/snippet}

{#if canAdd}
	<FormDialog
		bind:open={createOpen}
		icon={ZapIcon}
		title="Add event trigger"
		description="Matching events are published to a queue {project.slug} consumes and handled in queue()."
		action="?/createEventTrigger"
		submitLabel="Add trigger"
		size="lg"
	>
		<Field.Group>
			<Field.Field>
				<Field.Label for="event-source">Event source</Field.Label>
				<NativeSelect.Root id="event-source" name="source" bind:value={source} class="w-full">
					{#each events.sources as item (item.source)}
						<NativeSelect.Option value={item.source}
							>{SOURCES[item.source].label} — {SOURCES[item.source].blurb}</NativeSelect.Option
						>
					{/each}
				</NativeSelect.Root>
			</Field.Field>

			{#if source === 'storage'}
				{#if events.storage.length === 0}
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
								{#each events.storage as item (item.name)}
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
						{#each events.projects as item (item.slug)}
							<NativeSelect.Option value={item.slug}>{item.name}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
			{:else if source === 'registry'}
				<Field.Field>
					<Field.Label for="event-repository">Repository</Field.Label>
					<Input
						id="event-repository"
						name="repository"
						placeholder="Every repository (or <org>/<name>)"
						spellcheck="false"
						class="font-mono text-sm"
					/>
				</Field.Field>
			{:else if source === 'database-backups'}
				<Field.Field>
					<Field.Label for="event-database">Database</Field.Label>
					<NativeSelect.Root id="event-database" name="database" class="w-full">
						<NativeSelect.Option value="">Every database</NativeSelect.Option>
						{#each events.databases as name (name)}
							<NativeSelect.Option value={name}>{name}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
			{:else if source === 'alerts'}
				<Field.Field>
					<Field.Label for="event-alert">Alert rule</Field.Label>
					<NativeSelect.Root id="event-alert" name="alertRule" class="w-full">
						<NativeSelect.Option value="">Every alert rule</NativeSelect.Option>
						{#each events.alertRules as rule (rule.id)}
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

			{#if events.consumers.length > 0}
				<Field.Field>
					<Field.Label for="event-target">Deliver to queue</Field.Label>
					<NativeSelect.Root id="event-target" name="target" bind:value={target} class="w-full">
						{#each events.consumers as consumer (queueKey(consumer))}
							<NativeSelect.Option value={queueKey(consumer)}
								>{consumer.queue} · {consumer.broker}</NativeSelect.Option
							>
						{/each}
						{#if events.attachedBrokers.length > 0}
							<NativeSelect.Option value={NEW_QUEUE}>Another queue…</NativeSelect.Option>
						{/if}
					</NativeSelect.Root>
					<Field.Description
						>The queues {project.slug} consumes, from its wrangler.jsonc.</Field.Description
					>
				</Field.Field>
			{/if}

			{#if newQueue}
				<div class="grid gap-4 sm:grid-cols-2">
					<Field.Field data-invalid={fieldErrors.broker ? true : undefined}>
						<Field.Label for="event-broker">Broker</Field.Label>
						<NativeSelect.Root id="event-broker" name="broker" bind:value={broker} class="w-full">
							{#each events.attachedBrokers as name (name)}
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
						{project.slug} doesn't consume this queue yet. Add to
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

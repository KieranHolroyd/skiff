<script lang="ts">
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import ServerIcon from '@lucide/svelte/icons/server';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import type { FailoverEventView, FailoverStatusView } from '@yoal/contracts';
	import { createQuery } from '@tanstack/svelte-query';
	import { resolve } from '$app/paths';
	import { fetchJson } from '#lib/query.js';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import StatusDot from '#lib/components/yoal/StatusDot.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import type { Tone } from '#lib/status.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDateTime, formatRelative } from '../../_lib/format.js';
	import PolicyPanel from '../_lib/PolicyPanel.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// The controller ticks every few seconds; refresh the view while the page is open.
	const live = createQuery(() => ({
		queryKey: ['ha-status'] as const,
		queryFn: ({ signal }) =>
			fetchJson<FailoverStatusView>('/api/v1/ha/status', { signal, cache: 'no-store' }),
		initialData: data.failover,
		refetchInterval: 10_000,
		staleTime: 5_000
	}));
	const failover = $derived(live.data ?? data.failover);
	const ingressById = $derived(new Map(failover.ingress.nodes.map((node) => [node.id, node])));

	const leaseTone: Record<FailoverStatusView['lease']['state'], Tone> = {
		holder: 'success',
		standby: 'neutral',
		fenced: 'danger',
		idle: 'warning'
	};
	const eventTone: Record<FailoverEventView['status'], Tone> = {
		queued: 'neutral',
		'in-progress': 'info',
		completed: 'success',
		failed: 'danger',
		blocked: 'warning',
		expired: 'warning',
		cancelled: 'neutral',
		manual: 'warning'
	};
	const kindLabel: Record<FailoverEventView['kind'], string> = {
		replica: 'Replica copy',
		ingress: 'Ingress',
		database: 'Database',
		lease: 'Lease'
	};

	function seconds(value: number): string {
		return value >= 120 && value % 60 === 0 ? `${value / 60} min` : `${value}s`;
	}
</script>

<SettingsHeader
	id="high-availability"
	description="The failover controller, its lease and history, the ingress driver, and the nodes allowed to serve traffic."
/>

<div class="space-y-6">
	<Panel
		title="Failover controller"
		icon={ShieldCheckIcon}
		description="Moves replica copies off a lost or draining node, tracks the ingress record set and decides database failovers. Only the holder of the lease acts."
	>
		{#snippet actions()}
			<Button variant="outline" size="sm" href={resolve('/(dashboard)/settings/clustering')}>Edit policy</Button>
		{/snippet}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
			<div class="rounded-lg border p-3">
				<p class="text-xs text-muted-foreground">Automatic failover</p>
				<p class="mt-1">
					<Badge variant={failover.enabled ? 'success' : 'neutral'}>{failover.enabled ? 'On' : 'Off'}</Badge>
				</p>
				<p class="mt-1 text-xs text-muted-foreground">
					{failover.enabled ? 'Lost nodes are acted on.' : 'Lost nodes are reported only. Drains still move copies.'}
				</p>
			</div>
			<div class="rounded-lg border p-3">
				<p class="text-xs text-muted-foreground">Lease</p>
				<p class="mt-1 flex items-center gap-2">
					<StatusBadge status={failover.lease.state} tone={leaseTone[failover.lease.state]} />
					{#if failover.lease.epoch}<span class="font-mono text-xs">epoch {failover.lease.epoch}</span>{/if}
				</p>
				<p class="mt-1 truncate font-mono text-xs text-muted-foreground" title={failover.lease.holderId ?? ''}>
					{failover.lease.self ? 'This control plane' : (failover.lease.holderId ?? 'Nobody holds it')}
				</p>
			</div>
			<div class="rounded-lg border p-3">
				<p class="text-xs text-muted-foreground">Last tick</p>
				<p class="mt-1 text-sm">{failover.lastTickAt ? formatRelative(failover.lastTickAt) : 'Not on this process'}</p>
				<p class="mt-1 text-xs text-muted-foreground">Every {seconds(failover.policy.tickSeconds)}, lease TTL {seconds(failover.policy.leaseTtlSeconds)}</p>
			</div>
			<div class="rounded-lg border p-3">
				<p class="text-xs text-muted-foreground">Actions</p>
				<p class="mt-1 text-sm tabular-nums">
					{failover.counts.lastMinute} in the last minute · {failover.counts.inProgress} in progress · {failover.counts.queued} waiting
				</p>
				<p class="mt-1 text-xs text-muted-foreground">
					At most {failover.policy.maxPerMinute}/min fleet-wide, {failover.policy.perTargetPerMinute}/min per target node
				</p>
			</div>
		</div>
		<dl class="mt-4 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
			<div><dt class="inline">Node lost after</dt> <dd class="inline font-medium text-foreground">{seconds(failover.policy.graceSeconds)} silent</dd></div>
			<div><dt class="inline">Replica copies move after</dt> <dd class="inline font-medium text-foreground">{seconds(failover.policy.replicaGraceSeconds)} silent</dd></div>
			<div><dt class="inline">Waiting moves expire after</dt> <dd class="inline font-medium text-foreground">{seconds(failover.policy.queueExpirySeconds)}</dd></div>
			<div><dt class="inline">A failover source is not a target for</dt> <dd class="inline font-medium text-foreground">{seconds(failover.policy.flapWindowSeconds)}</dd></div>
		</dl>
	</Panel>

	<Panel title="Nodes" icon={ServerIcon} description="How long each node has been silent, and the replica copies the controller would move." flush>
		<Table.Root>
			<Table.Header class="bg-muted/45">
				<Table.Row>
					<Table.Head class="pl-4">Node</Table.Head>
					<Table.Head>Last heartbeat</Table.Head>
					<Table.Head class="text-right">Copies</Table.Head>
					<Table.Head class="pr-4">Failover</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each failover.nodes as node (node.id)}
					<Table.Row>
						<Table.Cell class="pl-4">
							<div class="flex items-center gap-2">
								<StatusDot status={node.status} />
								<span class="font-medium">{node.name}</span>
								<Badge variant="outline" class="font-mono text-[10px]">{node.zone}</Badge>
							</div>
						</Table.Cell>
						<Table.Cell class="text-sm">
							{node.lastHeartbeatAt ? formatRelative(node.lastHeartbeatAt) : 'Never'}
						</Table.Cell>
						<Table.Cell class="text-right tabular-nums">{node.copies}</Table.Cell>
						<Table.Cell class="pr-4 text-sm">
							{#if node.status === 'draining'}
								<Badge variant="info">Draining: copies move</Badge>
							{:else if node.lost}
								<Badge variant="danger">Lost</Badge>
							{:else}
								<span class="text-muted-foreground">Healthy</span>
							{/if}
							{#if node.replicaFailoverAt && node.copies > 0}
								<p class="mt-0.5 text-xs text-muted-foreground">Copies move {formatRelative(node.replicaFailoverAt)}</p>
							{/if}
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Panel>

	{#if failover.databases.length}
		<Panel title="Database primaries" icon={DatabaseIcon} description="Databases with replicas, and the replica a promotion would pick under the lag limits." flush>
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">Database</Table.Head>
						<Table.Head>Primary</Table.Head>
						<Table.Head>Candidate</Table.Head>
						<Table.Head class="pr-4">Promotion</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each failover.databases as database (database.id)}
						<Table.Row>
							<Table.Cell class="pl-4 font-mono text-sm">{database.name}</Table.Cell>
							<Table.Cell class="text-sm">
								{database.nodeName ?? database.nodeId ?? '—'}
								{#if database.primaryLost}<Badge variant="danger" class="ml-1">Lost</Badge>{/if}
							</Table.Cell>
							<Table.Cell class="text-sm">
								{#if database.candidate}
									{database.candidate.nodeName ?? database.candidate.nodeId}
								{:else}
									<span class="text-muted-foreground">None</span>
								{/if}
								{#each database.refusals as refusal (refusal)}
									<p class="text-xs text-muted-foreground">{refusal}</p>
								{/each}
							</Table.Cell>
							<Table.Cell class="pr-4">
								<Badge variant={database.automatic ? 'success' : 'neutral'}>{database.automatic ? 'Automatic' : 'Manual'}</Badge>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Panel>
	{/if}

	{#if data.canEditPolicies}
		<PolicyPanel group="ingress" policies={data.policies} defaults={data.policyDefaults} {form}>
			<div class="mb-5 grid gap-4 sm:grid-cols-3">
				<div class="rounded-lg border p-3">
					<p class="text-xs text-muted-foreground">Driver in use</p>
					<p class="font-mono text-sm">{data.status.driver}</p>
					<p class="mt-1 text-xs text-muted-foreground">
						{failover.ingress.rotates ? 'The controller tracks the record set.' : 'No record set to rotate.'}
					</p>
				</div>
				<div class="rounded-lg border p-3">
					<p class="text-xs text-muted-foreground">Withdraw after</p>
					<p class="text-sm">{seconds(failover.policy.ingressHoldDownSeconds)}</p>
					<p class="mt-1 text-xs text-muted-foreground">Twice the hold-down ({data.status.policy.holdDownSeconds}s), at least 120 s</p>
				</div>
				<div class="rounded-lg border p-3">
					<p class="text-xs text-muted-foreground">Re-add after</p>
					<p class="text-sm">{seconds(data.status.policy.readdSeconds)} healthy</p>
					<p class="mt-1 text-xs text-muted-foreground">At most once per 10 min; withdrawn twice in 30 min pins it out</p>
				</div>
			</div>
		</PolicyPanel>
	{/if}

	<Panel title="Ingress nodes" icon={ActivityIcon} description="Every node holding the ingress role, with readiness and its place in the record set.">
		{#if data.status.nodes.length === 0}
			<p class="text-sm text-muted-foreground">No ingress nodes.</p>
		{:else}
			<div class="space-y-2">
				{#each data.status.nodes as node (node.id)}
					{@const rotation = ingressById.get(node.id)}
					<div class="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
						<div class="flex items-center gap-2">
							<StatusDot status={node.status} />
							<span class="font-medium">{node.name}</span>
							<Badge variant="outline" class="font-mono text-[10px]">{node.zone}</Badge>
						</div>
						<div class="flex flex-wrap items-center gap-1.5">
							{#if rotation?.pinned}
								<Badge variant="warning" title={rotation.pinnedUntil ? `Until ${formatDateTime(rotation.pinnedUntil)}` : undefined}>Pinned out</Badge>
							{/if}
							{#if failover.ingress.rotates && rotation}
								<Badge variant={rotation.inRotation ? 'success' : 'secondary'}>{rotation.inRotation ? 'In rotation' : 'Withdrawn'}</Badge>
							{/if}
							<Badge variant={node.ready ? 'success' : 'secondary'}>{node.ready ? 'ready' : 'not ready'}</Badge>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</Panel>

	<Panel title="Failover history" icon={HistoryIcon} description="Every action the controller decided on, newest first. The epoch is the lease it acted under." count={failover.recent.length} flush>
		{#if failover.recent.length === 0}
			<div class="p-4">
				<EmptyState icon={HistoryIcon} compact title="No failover events" description="Moves, ingress withdrawals, database decisions and lease changes appear here." />
			</div>
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">When</Table.Head>
						<Table.Head>What</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head class="hidden lg:table-cell">Reason</Table.Head>
						<Table.Head class="pr-4 text-right">Epoch</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each failover.recent as event (event.id)}
						<Table.Row>
							<Table.Cell class="pl-4 text-sm whitespace-nowrap" title={formatDateTime(event.detectedAt)}>
								{formatRelative(event.detectedAt)}
							</Table.Cell>
							<Table.Cell class="max-w-72">
								<p class="text-sm">
									<span class="text-muted-foreground">{kindLabel[event.kind]}</span>
									<span class="font-mono">{event.subjectName ?? event.subjectId}</span>
								</p>
								{#if event.fromNodeId || event.toNodeId}
									<p class="text-xs text-muted-foreground">
										{event.fromNodeName ?? event.fromNodeId ?? '—'} → {event.toNodeName ?? event.toNodeId ?? '—'}
									</p>
								{/if}
							</Table.Cell>
							<Table.Cell>
								<StatusBadge status={event.status} tone={eventTone[event.status]} />
								<p class="mt-0.5 text-xs text-muted-foreground">{event.stage}</p>
							</Table.Cell>
							<Table.Cell class="hidden max-w-md text-xs whitespace-normal text-muted-foreground lg:table-cell">{event.reason}</Table.Cell>
							<Table.Cell class="pr-4 text-right font-mono text-xs">{event.epoch}</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Panel>
</div>

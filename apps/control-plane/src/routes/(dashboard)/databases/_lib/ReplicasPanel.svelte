<script lang="ts">
	import ArrowUpCircleIcon from '@lucide/svelte/icons/circle-arrow-up';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import type {
		DatabaseFailoverView,
		DatabaseReplicaView,
		DatabaseView,
		NodeCapacityView
	} from '@yoal/contracts';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import { formatBytes, formatDateTime, formatRelative } from '../../_lib/format.js';

	/**
	 * Postgres streaming read replicas (docs/CLUSTERING.md §9.2–9.3). Status and lag come from the
	 * primary's slot sample; promotion is a typed confirmation and is never offered over MCP.
	 */
	let {
		db,
		replicas,
		failovers,
		targets,
		canUpdate
	}: {
		db: DatabaseView;
		replicas: DatabaseReplicaView[];
		failovers: DatabaseFailoverView[];
		/** Online nodes a replica could be added on (the primary's own node included). */
		targets: NodeCapacityView[];
		canUpdate: boolean;
	} = $props();

	const PROMOTION_MAX_LAG_BYTES = 64 * 1024 * 1024;
	const PROMOTION_MAX_LAG_SECONDS = 60;
	const REPORT_STALE_MS = 120_000;

	const deleted = $derived(db.deletedAt !== null);
	const postgres = $derived(db.engine === 'postgres');
	const failingOver = $derived(
		failovers.some((item) => item.stage !== 'completed' && item.stage !== 'failed')
	);
	const used = $derived(new Set(replicas.map((replica) => replica.nodeId)));
	const addable = $derived(targets.filter((node) => !used.has(node.nodeId)));
	let node = $state('');

	function lag(replica: DatabaseReplicaView): string | null {
		if (replica.lagSeconds === null && replica.lagBytes === null) return null;
		const parts: string[] = [];
		if (replica.lagSeconds !== null)
			parts.push(`${replica.lagSeconds < 10 ? replica.lagSeconds.toFixed(1) : Math.round(replica.lagSeconds)} s`);
		if (replica.lagBytes !== null) parts.push(formatBytes(replica.lagBytes));
		return parts.join(' · ');
	}

	/** Mirrors the server's §9.3 checks, so the dialog says up front that data may be lost. */
	function risks(replica: DatabaseReplicaView): string[] {
		const out: string[] = [];
		if (replica.status !== 'streaming') out.push(`it is ${replica.status}`);
		if (replica.lagBytes !== null && replica.lagBytes > PROMOTION_MAX_LAG_BYTES)
			out.push(`${formatBytes(replica.lagBytes)} behind`);
		if (replica.lagSeconds !== null && replica.lagSeconds > PROMOTION_MAX_LAG_SECONDS)
			out.push(`${Math.round(replica.lagSeconds)} s behind`);
		if (!replica.reportedAt || Date.now() - Date.parse(replica.reportedAt) > REPORT_STALE_MS)
			out.push('its lag was not reported recently');
		return out;
	}

	function promotable(replica: DatabaseReplicaView): boolean {
		return (
			canUpdate &&
			!deleted &&
			!failingOver &&
			!replica.sameNode &&
			!replica.removing &&
			replica.replayLsn !== null &&
			replica.status !== 'pending' &&
			replica.status !== 'failed' &&
			replica.status !== 'lost'
		);
	}

	function promote(replica: DatabaseReplicaView) {
		const risky = risks(replica);
		askConfirm({
			title: `Promote the replica on ${replica.nodeName ?? replica.nodeId}?`,
			description:
				`The current primary on ${db.nodeName ?? db.nodeId} is stopped first, then this replica becomes the primary ` +
				'and attached apps are re-pointed (their connections drop once). The old primary cannot be brought back in place; ' +
				'its node deletes its copy when it next checks in.' +
				(risky.length
					? ` Commits it has not replayed are lost: ${risky.join('; ')}.`
					: ' It is streaming within the 64 MB / 60 s budget.'),
			confirmLabel: risky.length ? 'Promote and accept data loss' : 'Promote',
			tone: 'danger',
			typeToConfirm: db.name,
			action: '?/promoteReplica',
			fields: {
				id: replica.id,
				generation: String(db.primaryGeneration),
				...(risky.length ? { acceptDataLoss: 'on' } : {})
			}
		});
	}

	function remove(replica: DatabaseReplicaView) {
		askConfirm({
			title: `Remove the replica on ${replica.nodeName ?? replica.nodeId}?`,
			description:
				'It stops, its node deletes its copy of the data and the primary drops its replication slot. The primary is untouched; ' +
				'apps reading from it lose their read URL.',
			confirmLabel: 'Remove replica',
			tone: 'danger',
			action: '?/removeReplica',
			fields: { id: replica.id }
		});
	}
</script>

{#if postgres}
	<Panel
		title="Replicas"
		icon={LayersIcon}
		description="Streaming read replicas. Apps get DATABASE_READ_URL while one they can reach is streaming; reads can trail by the lag."
	>
		{#if replicas.length === 0}
			<p class="text-sm text-muted-foreground">
				No replicas. One on another node protects against losing this node; one on the same node only
				adds read capacity.
			</p>
		{:else}
			<div class="space-y-2">
				{#each replicas as replica (replica.id)}
					<div
						class="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
					>
						<div class="min-w-0 space-y-1">
							<div class="flex flex-wrap items-center gap-2">
								<span class="font-medium">{replica.nodeName ?? replica.nodeId}</span>
								{#if replica.sameNode}
									<Badge variant="outline" class="text-[10px]">same node · reads only</Badge>
								{:else}
									<Badge variant="outline" class="font-mono text-[10px]">{replica.zone ?? 'zone?'}</Badge>
								{/if}
								<StatusBadge status={replica.removing ? 'removing' : replica.status} />
								{#if lag(replica)}
									<span class="text-xs text-muted-foreground">lag {lag(replica)}</span>
								{/if}
							</div>
							<div class="text-xs text-muted-foreground">
								<span class="font-mono">{replica.id}</span>
								{#if replica.hostPort !== null}· port {replica.hostPort}{/if}
								{#if replica.replayLsn}· replayed <span class="font-mono">{replica.replayLsn}</span>{/if}
								{#if replica.reportedAt}· reported {formatRelative(replica.reportedAt)}{/if}
							</div>
							{#if replica.message}
								<p class="text-xs text-muted-foreground">{replica.message}</p>
							{/if}
						</div>
						{#if canUpdate && !replica.removing}
							<div class="flex items-center gap-1">
								{#if promotable(replica)}
									<Button variant="outline" size="xs" onclick={() => promote(replica)}>
										<ArrowUpCircleIcon class="size-3.5" />Promote
									</Button>
								{/if}
								<Button
									variant="ghost"
									size="xs"
									aria-label="Remove replica"
									onclick={() => remove(replica)}
								>
									<TrashIcon class="size-3.5" />
								</Button>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		{#if canUpdate && !deleted && addable.length > 0}
			<form method="POST" action="?/addReplica" class="mt-3 flex flex-wrap items-end gap-2">
				<label class="text-xs text-muted-foreground" for="replica-node">Add on</label>
				<NativeSelect.Root id="replica-node" name="node" class="h-8" bind:value={node} required>
					{#each addable as target (target.nodeId)}
						<NativeSelect.Option value={target.nodeId}>
							{target.name}{target.nodeId === db.nodeId ? ' (same node: reads only)' : ''}
						</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
				<Button type="submit" size="sm" variant="outline"><PlusIcon />Add replica</Button>
			</form>
		{/if}

		{#if failovers.length > 0}
			<div class="mt-4 space-y-1 border-t pt-3">
				<p class="text-xs font-medium text-muted-foreground">
					Promotions · primary generation {db.primaryGeneration}
				</p>
				{#each failovers.slice(0, 5) as failover (failover.id)}
					<p class="text-xs">
						<span class="text-muted-foreground">{formatDateTime(failover.startedAt)}</span>
						{failover.fromNodeName ?? failover.fromNodeId ?? '?'} → {failover.toNodeName ?? failover.toNodeId}
						<StatusBadge status={failover.stage} />
						{#if failover.message}<span class="text-muted-foreground">{failover.message}</span>{/if}
					</p>
				{/each}
			</div>
		{/if}
	</Panel>
{/if}

<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatBytes, formatDateTime } from '../../_lib/format.js';
	import {
		actionLabel,
		operationDuration,
		operationStatusLabel,
		operationStatusTone
	} from '../../_lib/operations/copy.js';
	import PruneCard from './PruneCard.svelte';
	import type { PageProps } from './$types';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';

	let { data }: PageProps = $props();

	function actorName(id: string | null, type: string) {
		if (!id) return type === 'system' ? 'Skiff' : '—';
		if (id === data.userId) return 'You';
		return data.actors[id] ?? id;
	}
</script>

<svelte:head><title>Maintenance · Settings · Skiff</title></svelte:head>

<SettingsHeader id="maintenance" />

<div class="space-y-6">
	{#if data.canPrune}
		<PruneCard
			canPrunePlatform={data.canPrunePlatform}
			active={data.activePrune}
			onsettled={() => invalidateAll()}
		/>
	{/if}

	<Panel
		title="History"
		icon={HistoryIcon}
		description="Recent mass actions and prune runs. Finished operations are kept for {data.policies
			.operationHistoryDays} days (Settings → Policies)."
		count={data.history.length}
		flush
	>
		{#if data.history.length === 0}
			<div class="px-4 py-4">
				<EmptyState
					compact
					icon={HistoryIcon}
					title="Nothing has run yet"
					description="Bulk deletes, restores and prune runs show up here."
				/>
			</div>
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">Action</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head class="hidden md:table-cell">By</Table.Head>
						<Table.Head class="text-right">Items</Table.Head>
						<Table.Head class="hidden text-right sm:table-cell">Duration</Table.Head>
						<Table.Head class="hidden pr-4 lg:table-cell">Started</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.history as operation (operation.id)}
						{@const href = resolve('/(dashboard)/settings/maintenance/operations/[id]', {
							id: operation.id
						})}
						<Table.Row class="group">
							<Table.Cell class="pl-4">
								<a {href} class="font-medium underline-offset-4 group-hover:underline"
									>{actionLabel(operation.action)}</a
								>
								<p class="font-mono text-xs text-muted-foreground">
									{operation.id}{operation.scope === 'platform' ? ' · platform' : ''}
								</p>
							</Table.Cell>
							<Table.Cell>
								<StatusBadge
									status={operation.status}
									label={operationStatusLabel(operation.status)}
									tone={operationStatusTone(operation.status)}
								/>
							</Table.Cell>
							<Table.Cell class="hidden text-sm md:table-cell">
								{actorName(operation.actor.id, operation.actor.type)}
								{#if operation.actor.type !== 'user'}
									<span class="text-xs text-muted-foreground">({operation.actor.type})</span>
								{/if}
							</Table.Cell>
							<Table.Cell class="text-right font-mono text-xs tabular-nums">
								{operation.summary.statuses.succeeded} / {operation.total}
								{#if operation.failed}
									<span class="text-destructive">· {operation.failed} failed</span>
								{/if}
								{#if operation.summary.freedBytes}
									<p class="text-muted-foreground">{formatBytes(operation.summary.freedBytes)}</p>
								{/if}
							</Table.Cell>
							<Table.Cell
								class="hidden text-right font-mono text-xs text-muted-foreground sm:table-cell"
							>
								{operationDuration(operation)}
							</Table.Cell>
							<Table.Cell class="hidden pr-4 font-mono text-xs text-muted-foreground lg:table-cell">
								<time datetime={operation.createdAt}>{formatDateTime(operation.createdAt)}</time>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Panel>
</div>

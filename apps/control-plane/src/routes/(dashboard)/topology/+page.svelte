<script lang="ts">
	import { resolve } from '$app/paths';
	import type { BlastRadiusView, TopologyNodeView, TopologyView } from '@yoal/contracts';
	import NetworkIcon from '@lucide/svelte/icons/network';
	import ServerIcon from '@lucide/svelte/icons/server';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import { formatBytes } from '../_lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const view = $derived(data.view as TopologyView | null);
	const blast = $derived(data.blast as Record<string, BlastRadiusView>);

	function hardwareSummary(node: TopologyNodeView): string {
		const hw = node.hardware;
		if (!hw) return 'not reported';
		const parts: string[] = [];
		if (hw.cores) parts.push(`${hw.cores} cores`);
		if (hw.memoryBytes) parts.push(`${Math.round(hw.memoryBytes / 1024 ** 3)} GB RAM`);
		if (hw.gpus?.length) parts.push(`${hw.gpus.length} GPU${hw.gpus.length === 1 ? '' : 's'}`);
		if (hw.virtualization && hw.virtualization !== 'none') parts.push(hw.virtualization);
		return parts.join(' · ') || 'reported';
	}

	function diskSummary(node: TopologyNodeView): string {
		if (node.disks.length === 0) return 'system disk only';
		return node.disks.map((disk) => `${disk.name} (${disk.tier}${disk.remote ? ', network' : ''}${disk.freeBytes !== null ? `, ${formatBytes(disk.freeBytes)} free` : ''})`).join(', ');
	}
</script>

<PageHeader
	title="Topology"
	description="Failure domains, node roles and hardware, and what an outage of each node would take down."
>
	<Badge variant="outline"><NetworkIcon class="size-3.5" /> C0 read-only</Badge>
</PageHeader>

{#if data.denied}
	<EmptyState
		icon={ServerIcon}
		title="Platform admin required"
		description="Topology is a platform-level view: it names every node, zone and workload in the fleet."
	/>
{:else if view}
	<div class="flex flex-col gap-6">
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each view.zones as zone (zone.zone)}
				<Card.Root>
					<Card.Header>
						<Card.Title class="flex items-center gap-2 text-base">
							<span class="font-mono">{zone.zone}</span>
							<Badge variant="secondary">{zone.nodes.length} node{zone.nodes.length === 1 ? '' : 's'}</Badge>
						</Card.Title>
						<Card.Description>What this zone would take down before failover.</Card.Description>
					</Card.Header>
					<Card.Content class="text-sm">
						<dl class="grid grid-cols-3 gap-2 text-center">
							<div class="rounded-lg border p-2">
								<dt class="text-xs text-muted-foreground">Workloads</dt>
								<dd class="text-lg font-semibold">{zone.workloads}</dd>
							</div>
							<div class="rounded-lg border p-2">
								<dt class="text-xs text-muted-foreground">Databases</dt>
								<dd class="text-lg font-semibold">{zone.databases}</dd>
							</div>
							<div class="rounded-lg border p-2">
								<dt class="text-xs text-muted-foreground">Storage</dt>
								<dd class="text-lg font-semibold">{zone.storageInstances}</dd>
							</div>
						</dl>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>

		<Card.Root>
			<Card.Header>
				<Card.Title>Nodes</Card.Title>
				<Card.Description>
					Roles are what a node may run; the blast radius is computed from current placement.
				</Card.Description>
			</Card.Header>
			<Card.Content class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="text-left text-xs uppercase tracking-wide text-muted-foreground">
						<tr class="border-b">
							<th class="px-2 py-2">Node</th>
							<th class="px-2 py-2">Zone</th>
							<th class="px-2 py-2">Roles</th>
							<th class="px-2 py-2">Hardware</th>
							<th class="px-2 py-2">Disks</th>
							<th class="px-2 py-2">Blast radius</th>
						</tr>
					</thead>
					<tbody>
						{#each view.nodes as node (node.id)}
							<tr class="border-b last:border-0 align-top">
								<td class="px-2 py-3">
									<a class="font-medium hover:underline" href={resolve('/(dashboard)/nodes')}>{node.name}</a>
									<div class="text-xs text-muted-foreground">
										{node.status} · {node.mode}{node.publicAddress ? ` · ${node.publicAddress}` : ''}
									</div>
								</td>
								<td class="px-2 py-3 font-mono text-xs">{node.zone}</td>
								<td class="px-2 py-3">
									<div class="flex flex-wrap gap-1">
										{#each node.roles as role (role)}
											<Badge variant="outline" class="font-mono text-[11px]">{role}</Badge>
										{/each}
									</div>
								</td>
								<td class="px-2 py-3">
									<div>{hardwareSummary(node)}</div>
									{#if Object.keys(node.labels).length > 0}
										<div class="text-xs text-muted-foreground">
											{Object.entries(node.labels).map(([key, value]) => `${key}=${value}`).join(' · ')}
										</div>
									{/if}
								</td>
								<td class="px-2 py-3 text-xs">{diskSummary(node)}</td>
								<td class="px-2 py-3">
									{#if blast[node.id]}
										<div class="flex flex-wrap gap-1 text-xs">
											<Badge variant="secondary">{blast[node.id]!.summary.workloads} app</Badge>
											<Badge variant="secondary">{blast[node.id]!.summary.databases} db</Badge>
											<Badge variant="secondary">{blast[node.id]!.summary.storageInstances} storage</Badge>
											<Badge variant="secondary">{blast[node.id]!.summary.disks} disk</Badge>
										</div>
									{:else}
										<span class="text-xs text-muted-foreground">—</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</Card.Content>
		</Card.Root>

		<Separator />
		<p class="text-xs text-muted-foreground">
			Read-only in C0. Zones, roles and labels are edited on the node; placement constraints arrive
			with the placement API. Managed instances are <span class="font-mono">L0</span> today.
		</p>
	</div>
{/if}

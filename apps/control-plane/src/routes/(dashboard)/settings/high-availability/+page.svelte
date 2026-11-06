<script lang="ts">
	import NetworkIcon from '@lucide/svelte/icons/network';
	import { resolve } from '$app/paths';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import StatusDot from '#lib/components/skiff/StatusDot.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<SettingsHeader
	id="high-availability"
	description="Ingress driver, failover policy and the nodes currently allowed to serve traffic."
/>

<div class="space-y-6">
	<Panel title="Ingress" icon={NetworkIcon} description="C5 is configuration and status today; DNS record maintenance is not enabled.">
		<div class="grid gap-4 sm:grid-cols-3">
			<div class="rounded-lg border p-3">
				<p class="text-xs text-muted-foreground">Driver</p>
				<p class="font-mono text-sm">{data.status.driver}</p>
			</div>
			<div class="rounded-lg border p-3">
				<p class="text-xs text-muted-foreground">Withdraw after</p>
				<p class="text-sm">{data.status.policy.holdDownSeconds}s</p>
			</div>
			<div class="rounded-lg border p-3">
				<p class="text-xs text-muted-foreground">Re-add after</p>
				<p class="text-sm">{data.status.policy.readdSeconds}s</p>
			</div>
		</div>
		<div class="mt-4">
			<Button variant="outline" size="sm" href={resolve('/(dashboard)/settings/policies')}>Edit policy</Button>
		</div>
	</Panel>

	<Card.Root>
		<Card.Header>
			<Card.Title>Ingress nodes</Card.Title>
			<Card.Description>Every node holding the ingress role, with current readiness.</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if data.status.nodes.length === 0}
				<p class="text-sm text-muted-foreground">No ingress nodes.</p>
			{:else}
				<div class="space-y-2">
					{#each data.status.nodes as node (node.id)}
						<div class="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
							<div class="flex items-center gap-2">
								<StatusDot status={node.status} />
								<span class="font-medium">{node.name}</span>
								<Badge variant="outline" class="font-mono text-[10px]">{node.zone}</Badge>
							</div>
							<Badge variant={node.ready ? 'success' : 'secondary'}>{node.ready ? 'ready' : 'not ready'}</Badge>
						</div>
					{/each}
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>

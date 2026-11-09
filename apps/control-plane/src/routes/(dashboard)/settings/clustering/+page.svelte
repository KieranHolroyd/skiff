<script lang="ts">
	import NetworkIcon from '@lucide/svelte/icons/network';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import { resolve } from '$app/paths';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import { formatRelative } from '../../_lib/format.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	// svelte-ignore state_referenced_locally -- the page intentionally seeds the editor once
	let text = $state(JSON.stringify(data.config, null, 2));
	const result = $derived(form as { success?: string; message?: string } | null);
</script>

<SettingsHeader
	id="clustering"
	description="Advanced cluster tunables. Changes apply to the next join, placement, lease cycle or maintenance sweep."
/>

<Panel
	title="Failover"
	icon={ShieldCheckIcon}
	description="The failover controller as the keys below configure it right now."
	class="mb-5"
>
	{#snippet actions()}
		<Button variant="outline" size="sm" href={resolve('/(dashboard)/settings/high-availability')}>Open high availability</Button>
	{/snippet}
	<div class="flex flex-wrap items-center gap-2 text-sm">
		<Badge variant={data.failover.enabled ? 'success' : 'neutral'}>
			Automatic failover {data.failover.enabled ? 'on' : 'off'}
		</Badge>
		<StatusBadge status={data.failover.lease.state} label="Lease {data.failover.lease.state}" />
		{#if data.failover.lease.epoch}<span class="font-mono text-xs text-muted-foreground">epoch {data.failover.lease.epoch}</span>{/if}
		<span class="text-muted-foreground">
			· {data.failover.counts.inProgress} in progress · {data.failover.counts.queued} waiting
		</span>
	</div>
	<p class="mt-2 text-xs text-muted-foreground">
		{data.failover.enabled
			? `Copies on a node silent for ${data.failover.policy.replicaGraceSeconds}s move to another node, at most ${data.failover.policy.maxPerMinute} a minute.`
			: 'A lost node is reported, not acted on. Set "failover": { "enabled": true } to move replica copies automatically; a drain moves them either way.'}
	</p>
	{#if data.failover.recent.length}
		<ul class="mt-3 space-y-1 text-xs">
			{#each data.failover.recent.slice(0, 5) as event (event.id)}
				<li class="flex gap-2">
					<span class="w-20 shrink-0 text-muted-foreground">{formatRelative(event.detectedAt)}</span>
					<span class="shrink-0 font-medium">{event.kind} · {event.status}</span>
					<span class="truncate text-muted-foreground" title={event.reason}>{event.reason}</span>
				</li>
			{/each}
		</ul>
	{/if}
</Panel>

<form method="POST" action="?/save" class="space-y-5">
	<Panel title="Cluster configuration" icon={NetworkIcon} description="Validated against the ClusterConfig schema; unknown keys are rejected.">
		<Field.Field>
			<Field.Label for="cluster-config">JSON</Field.Label>
			<Textarea id="cluster-config" name="config" bind:value={text} rows={26} class="font-mono text-xs" spellcheck="false" />
			<Field.Description>
				Overlay CIDR/MTU/port, endpoint port range and mTLS, replica limits, spread, health-check interval and failover grace, database replica limits and promotion lag limits, storage targets, the failover controller's lease timing, automatic failover and the share mount root.
			</Field.Description>
		</Field.Field>
		{#if result?.message}<p class="text-sm text-destructive">{result.message}</p>{/if}
		{#if result?.success}<p class="text-sm text-success">{result.success}</p>{/if}
	</Panel>
	<div class="flex justify-end">
		<Button type="submit">Save configuration</Button>
	</div>
</form>

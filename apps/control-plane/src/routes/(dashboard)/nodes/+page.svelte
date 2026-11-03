<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CirclePauseIcon from '@lucide/svelte/icons/circle-pause';
	import CirclePlayIcon from '@lucide/svelte/icons/circle-play';
	import InfoIcon from '@lucide/svelte/icons/info';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ServerIcon from '@lucide/svelte/icons/server';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import FormFeedback from '#lib/components/skiff/FormFeedback.svelte';
	import SecretReveal from '#lib/components/skiff/SecretReveal.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import StatusDot from '#lib/components/skiff/StatusDot.svelte';
	import EmptyState from '../_lib/EmptyState.svelte';
	import NodeStats from '../_lib/NodeStats.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import { formatDateTime } from '../_lib/format.js';
	import type { PageProps } from './$types';

	interface NodesFormResult {
		message?: string;
		success?: string;
		token?: string;
		command?: string;
		expiresAt?: string;
		rotatedToken?: string;
		nodeId?: string;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as NodesFormResult | null);

	const online = $derived(data.denied ? 0 : data.nodes.filter((n) => n.status === 'online').length);
</script>

<svelte:head>
	<title>Nodes · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		eyebrow="Platform"
		title="Nodes"
		description="Edge and worker machines running the Skiff agent. Agents pull desired state; the control plane never pushes."
	>
		{#if !data.denied}
			<form method="POST" action="?/createToken" use:enhance>
				<Button type="submit">
					<PlusIcon aria-hidden="true" />
					Create join token
				</Button>
			</form>
		{/if}
	</PageHeader>

	<FormFeedback {result} />

	{#if result?.command}
		<SecretReveal
			title="Join command"
			value={result.command}
			copyLabel="Copy command"
			multiline
		>
			<p class="text-xs text-muted-foreground">
				Run this on the machine you are enrolling. The token works once
				{#if result.expiresAt}
					and expires <time datetime={result.expiresAt}>{formatDateTime(result.expiresAt)}</time>.
				{:else}
					within one hour.
				{/if}
			</p>
		</SecretReveal>
	{/if}

	{#if result?.rotatedToken}
		<SecretReveal title="New node token" value={result.rotatedToken} copyLabel="Copy token">
			<p class="text-xs text-muted-foreground">
				Shown once. Set <span class="font-mono">SKIFF_NODE_TOKEN</span> in the node's environment, then
				restart the agent.
			</p>
		</SecretReveal>
	{/if}

	{#if data.denied}
		<EmptyState
			icon={ShieldAlertIcon}
			title="Platform admin required"
			description="Nodes, Caddy and global settings are platform-level resources. Your role can use projects and deployments, but cannot inspect or enrol machines."
		>
			<Button href={resolve('/(dashboard)/overview')} variant="outline" size="sm">
				Back to overview
			</Button>
			<Button href={resolve('/(dashboard)/settings')} variant="ghost" size="sm">View your role</Button>
		</EmptyState>
	{:else if data.nodes.length === 0}
		<EmptyState
			icon={ServerIcon}
			title="No nodes enrolled"
			description="Create a single-use join token, run the command on the machine, and it appears here after its first heartbeat."
		>
			<form method="POST" action="?/createToken" use:enhance>
				<Button type="submit" size="sm">
					<PlusIcon aria-hidden="true" />
					Create join token
				</Button>
			</form>
		</EmptyState>
	{:else}
		<p class="flex items-center gap-2 text-sm text-muted-foreground">
			<span class="font-mono text-foreground tabular-nums">{online}/{data.nodes.length}</span>
			nodes online
		</p>
		<ul class="grid gap-4 lg:grid-cols-2">
			{#each data.nodes as node (node.id)}
				<li class="flex flex-col overflow-hidden rounded-xl border bg-card shadow-card">
					<div class="flex items-start justify-between gap-3 p-4">
						<div class="flex min-w-0 items-start gap-3">
							<span
								class="relative grid size-10 shrink-0 place-items-center rounded-lg border bg-muted/40"
							>
								<ServerIcon class="size-[18px] text-muted-foreground" aria-hidden="true" />
								<StatusDot status={node.status} class="absolute -top-0.5 -right-0.5" />
							</span>
							<div class="min-w-0">
								<div class="flex flex-wrap items-center gap-2">
									<h2 class="truncate text-[15px] font-semibold tracking-[-0.01em]">{node.name}</h2>
									<Badge variant="outline" class="font-mono text-[10.5px] uppercase">{node.mode}</Badge>
								</div>
								<div class="mt-0.5 flex items-center gap-1">
									<p class="truncate font-mono text-[11px] text-muted-foreground" title={node.id}>
										{node.id}
									</p>
									<CopyButton value={node.id} label="Copy node ID" variant="ghost" iconOnly />
								</div>
							</div>
						</div>
						<StatusBadge status={node.status} />
					</div>

					{#if node.stats}
						<div class="px-4 pb-4">
							<NodeStats stats={node.stats} />
						</div>
					{/if}

					<dl class="kv mx-4 border-t text-[13px]">
						<dt>Agent</dt>
						<dd class="font-mono text-[12px]">{node.agentVersion ?? node.version ?? 'not reported'}</dd>
						<dt>Address</dt>
						<dd class="font-mono text-[12px]">{node.publicAddress ?? 'not reported'}</dd>
						<dt>Heartbeat</dt>
						<dd>
							{#if node.lastHeartbeatAt}
								<time datetime={node.lastHeartbeatAt}>{formatDateTime(node.lastHeartbeatAt)}</time>
							{:else}
								<span class="text-muted-foreground">never</span>
							{/if}
						</dd>
						<dt>Enrolled</dt>
						<dd><time datetime={node.createdAt}>{formatDateTime(node.createdAt)}</time></dd>
					</dl>

					{#if node.stats}
						<details class="group mx-4 mb-3">
							<summary
								class="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
							>
								<ChevronRightIcon
									class="size-3 transition-transform group-open:rotate-90"
									aria-hidden="true"
								/>
								Raw heartbeat stats
							</summary>
							<pre class="code-block mt-1.5 max-h-56">{JSON.stringify(node.stats, null, 2)}</pre>
						</details>
					{/if}

					<div class="mt-auto flex flex-wrap items-center gap-1.5 border-t bg-muted/30 px-4 py-2.5">
						<form method="POST" action="?/setDraining" use:enhance>
							<input type="hidden" name="nodeId" value={node.id} />
							<input
								type="hidden"
								name="draining"
								value={node.status === 'draining' ? 'false' : 'true'}
							/>
							<Button type="submit" variant="outline" size="sm">
								{#if node.status === 'draining'}
									<CirclePlayIcon aria-hidden="true" />
									Resume placements
								{:else}
									<CirclePauseIcon aria-hidden="true" />
									Drain
								{/if}
							</Button>
						</form>
						<form method="POST" action="?/rotateToken" use:enhance>
							<input type="hidden" name="nodeId" value={node.id} />
							<Button
								type="submit"
								variant="ghost"
								size="sm"
								onclick={(event) => {
									if (
										!confirm(
											`Rotate the token for ${node.name}? The current agent token stops working immediately.`
										)
									)
										event.preventDefault();
								}}
							>
								<RefreshCwIcon aria-hidden="true" />
								Rotate token
							</Button>
						</form>
					</div>
				</li>
			{/each}
		</ul>

		<div class="flex items-start gap-3 rounded-xl border border-dashed px-4 py-3 text-xs leading-relaxed text-muted-foreground">
			<InfoIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<p>
				An agent is marked offline after 30 seconds without a heartbeat and alerts after 2 minutes.
				Join tokens are single-use and valid for one hour. Draining stops new placements but keeps
				existing sites serving.
			</p>
		</div>
	{/if}
</div>

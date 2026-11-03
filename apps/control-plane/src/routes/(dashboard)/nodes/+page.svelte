<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CirclePlayIcon from '@lucide/svelte/icons/circle-play';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ServerIcon from '@lucide/svelte/icons/server';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import CopyButton from '../_lib/CopyButton.svelte';
	import EmptyState from '../_lib/EmptyState.svelte';
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

	function nodeTone(status: string): string {
		switch (status) {
			case 'online':
				return 'bg-emerald-500';
			case 'draining':
				return 'bg-amber-500';
			case 'offline':
				return 'bg-muted-foreground/50';
			default:
				return 'bg-sky-500';
		}
	}

	function nodeBadgeVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		switch (status) {
			case 'online':
				return 'default';
			case 'offline':
				return 'destructive';
			case 'draining':
				return 'secondary';
			default:
				return 'outline';
		}
	}
</script>

<svelte:head>
	<title>Nodes · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		title="Nodes"
		description="Edge and worker machines running the Skiff agent. Agents pull desired state; the control plane never pushes."
	>
		{#if !data.denied}
			<form method="POST" action="?/createToken" use:enhance>
				<Button type="submit" size="sm">
					<ServerIcon class="size-3.5" aria-hidden="true" />
					Create join token
				</Button>
			</form>
		{/if}
	</PageHeader>

	{#if result?.success}
		<div
			class="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
			role="status"
		>
			{result.success}
		</div>
	{/if}
	{#if result?.message}
		<div
			class="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
			role="alert"
		>
			{result.message}
		</div>
	{/if}

	{#if result?.command}
		<Card.Root size="sm" class="border-emerald-300/70 dark:border-emerald-500/30">
			<Card.Header class="border-b pb-3">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<div>
						<Card.Title>Join command</Card.Title>
						<Card.Description>
							Run this on the machine you are enrolling. The token works once
							{#if result.expiresAt}
								and expires <time datetime={result.expiresAt}
									>{formatDateTime(result.expiresAt)}</time
								>
							{:else}
								within one hour
							{/if}.
						</Card.Description>
					</div>
					<CopyButton value={result.command} label="Copy command" />
				</div>
			</Card.Header>
			<Card.Content>
				<pre
					class="overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs">{result.command}</pre>
			</Card.Content>
		</Card.Root>
	{/if}

	{#if result?.rotatedToken}
		<Card.Root size="sm" class="border-amber-300/70 dark:border-amber-500/30">
			<Card.Header class="border-b pb-3">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<div>
						<Card.Title>New node token</Card.Title>
						<Card.Description
							>Shown once. Set <span class="font-mono">SKIFF_NODE_TOKEN</span> in the node's environment,
							then restart the agent.</Card.Description
						>
					</div>
					<CopyButton value={result.rotatedToken} label="Copy token" />
				</div>
			</Card.Header>
			<Card.Content>
				<code class="block overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs"
					>{result.rotatedToken}</code
				>
			</Card.Content>
		</Card.Root>
	{/if}

	{#if data.denied}
		<Card.Root>
			<Card.Content class="py-8">
				<EmptyState
					title="Platform admin required"
					description="Nodes, Caddy and global settings are platform-level resources. Your current role can use projects and deployments, but cannot inspect or enrol machines."
				>
					<Button href={resolve('/(dashboard)/overview')} variant="outline" size="sm">
						<ShieldAlertIcon class="size-3.5" aria-hidden="true" />
						Back to overview
					</Button>
					<Button href={resolve('/(dashboard)/settings')} variant="ghost" size="sm"
						>View your role</Button
					>
				</EmptyState>
			</Card.Content>
		</Card.Root>
	{:else if data.nodes.length === 0}
		<Card.Root>
			<Card.Content class="py-8">
				<EmptyState
					title="No nodes enrolled"
					description="Create a single-use join token, run the command on the machine, and it will appear here after its first heartbeat."
				>
					<form method="POST" action="?/createToken" use:enhance>
						<Button type="submit" size="sm">Create join token</Button>
					</form>
				</EmptyState>
			</Card.Content>
		</Card.Root>
	{:else}
		<ul class="grid gap-3 lg:grid-cols-2">
			{#each data.nodes as node (node.id)}
				<li class="rounded-xl border bg-card p-4 text-sm shadow-xs">
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0">
							<div class="flex flex-wrap items-center gap-2">
								<span class="size-1.5 rounded-full {nodeTone(node.status)}" aria-hidden="true"
								></span>
								<h2 class="truncate font-medium">{node.name}</h2>
								<Badge variant="outline" class="capitalize">{node.mode}</Badge>
							</div>
							<p class="mt-1 font-mono text-xs text-muted-foreground" title={node.id}>{node.id}</p>
						</div>
						<Badge variant={nodeBadgeVariant(node.status)}>{node.status}</Badge>
					</div>

					<dl class="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
						<dt class="text-muted-foreground">Agent</dt>
						<dd class="font-mono">{node.agentVersion ?? node.version ?? 'not reported'}</dd>
						<dt class="text-muted-foreground">Address</dt>
						<dd class="font-mono">{node.publicAddress ?? 'not reported'}</dd>
						<dt class="text-muted-foreground">Heartbeat</dt>
						<dd>
							{#if node.lastHeartbeatAt}
								<time datetime={node.lastHeartbeatAt}>{formatDateTime(node.lastHeartbeatAt)}</time>
							{:else}
								never
							{/if}
						</dd>
						<dt class="text-muted-foreground">Enrolled</dt>
						<dd><time datetime={node.createdAt}>{formatDateTime(node.createdAt)}</time></dd>
					</dl>

					{#if node.stats}
						<details class="mt-3">
							<summary class="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
								>Reported stats</summary
							>
							<pre
								class="mt-1 max-h-56 overflow-auto rounded-md border bg-muted/30 p-2 text-[11px] leading-relaxed">{JSON.stringify(
									node.stats,
									null,
									2
								)}</pre>
						</details>
					{/if}

					<div class="mt-4 flex flex-wrap items-center gap-1 border-t pt-3">
						<form method="POST" action="?/setDraining" use:enhance>
							<input type="hidden" name="nodeId" value={node.id} />
							<input
								type="hidden"
								name="draining"
								value={node.status === 'draining' ? 'false' : 'true'}
							/>
							<Button type="submit" variant="outline" size="xs">
								{#if node.status === 'draining'}
									<CirclePlayIcon class="size-3.5" aria-hidden="true" />
									Resume
								{:else}
									Drain
								{/if}
							</Button>
						</form>
						<form method="POST" action="?/rotateToken" use:enhance>
							<input type="hidden" name="nodeId" value={node.id} />
							<Button
								type="submit"
								variant="ghost"
								size="xs"
								onclick={(event) => {
									if (
										!confirm(
											`Rotate the token for ${node.name}? The current agent token stops working immediately.`
										)
									)
										event.preventDefault();
								}}
							>
								<RefreshCwIcon class="size-3.5" aria-hidden="true" />
								Rotate token
							</Button>
						</form>
					</div>
				</li>
			{/each}
		</ul>

		<Card.Root size="sm">
			<Card.Content class="flex flex-wrap items-start gap-3 text-xs text-muted-foreground">
				<ShieldAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
				<p>
					An agent is marked offline after 30 seconds without a heartbeat and alerts after 2
					minutes. Join tokens are single-use and valid for one hour. Draining stops new placements
					but keeps existing sites serving.
				</p>
			</Card.Content>
		</Card.Root>
	{/if}
</div>

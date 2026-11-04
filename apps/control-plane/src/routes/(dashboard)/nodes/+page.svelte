<script lang="ts">
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import { resolve } from '$app/paths';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CirclePauseIcon from '@lucide/svelte/icons/circle-pause';
	import CirclePlayIcon from '@lucide/svelte/icons/circle-play';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import HammerIcon from '@lucide/svelte/icons/hammer';
	import InfoIcon from '@lucide/svelte/icons/info';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ServerIcon from '@lucide/svelte/icons/server';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import { toast } from 'svelte-sonner';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import SecretDialog from '#lib/components/skiff/SecretDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import StatusDot from '#lib/components/skiff/StatusDot.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import NodeStats from '../_lib/NodeStats.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import RowMenu from '../_lib/RowMenu.svelte';
	import { formatDateTime } from '../_lib/format.js';
	import type { PageProps } from './$types';

	interface NodesFormResult {
		command?: string;
		expiresAt?: string;
		rotatedToken?: string;
		nodeId?: string;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as NodesFormResult | null);

	let addOpen = $state(false);
	let commandOpen = $state(false);
	let tokenOpen = $state(false);

	$effect(() => {
		if (result?.command) commandOpen = true;
	});
	$effect(() => {
		if (result?.rotatedToken) tokenOpen = true;
	});

	const online = $derived(data.denied ? 0 : data.nodes.filter((n) => n.status === 'online').length);
	const rotatedNode = $derived(
		data.denied ? undefined : data.nodes.find((node) => node.id === result?.nodeId)
	);
	const capacityByNode = $derived(new Map(data.capacity.map((item) => [item.nodeId, item])));

	function rotate(node: { id: string; name: string }) {
		askConfirm({
			title: `Rotate the token for ${node.name}?`,
			description:
				'The current agent token stops working immediately. You will need to update the node and restart the agent.',
			confirmLabel: 'Rotate token',
			tone: 'danger',
			action: '?/rotateToken',
			fields: { nodeId: node.id }
		});
	}

	function setBuilder(node: { id: string; name: string; canBuild: boolean }) {
		askConfirm({
			title: node.canBuild
				? `Remove the Builder role from ${node.name}?`
				: `Make ${node.name} a Builder?`,
			description: node.canBuild
				? 'Queued git builds wait for another Builder node. Existing deployments are unaffected.'
				: 'This node will claim git builds one at a time. Builds run in a transient sandboxed unit with a 10-minute cap.',
			confirmLabel: node.canBuild ? 'Remove Builder role' : 'Make Builder',
			tone: node.canBuild ? 'danger' : 'default',
			action: '?/setBuilder',
			fields: { nodeId: node.id, builder: node.canBuild ? 'false' : 'true' }
		});
	}

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		toast.success('Copied to the clipboard.');
	}
</script>

<svelte:head>
	<title>Nodes · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		eyebrow="Platform"
		title="Nodes"
		description="Edge and worker machines running the Skiff agent. Agents pull desired state; the control plane never pushes. App workloads are admitted against each node's workload slice, and a Builder node runs git builds."
	>
		{#if !data.denied}
			<Button onclick={() => (addOpen = true)}>
				<PlusIcon />
				Add node
			</Button>
		{/if}
	</PageHeader>

	{#if data.denied}
		<EmptyState
			icon={ShieldAlertIcon}
			title="Platform admin required"
			description="Nodes, Caddy and global settings are platform-level resources. Your role can use projects and deployments, but cannot inspect or enrol machines."
		>
			<Button href={resolve('/(dashboard)/overview')} variant="outline" size="sm"
				>Back to overview</Button
			>
			<Button href={resolve('/(dashboard)/settings')} variant="ghost" size="sm"
				>View your role</Button
			>
		</EmptyState>
	{:else if data.nodes.length === 0}
		<EmptyState
			icon={ServerIcon}
			title="No nodes enrolled"
			description="Generate a single-use join command, run it on the machine, and it appears here after its first heartbeat."
		>
			<Button size="sm" onclick={() => (addOpen = true)}><PlusIcon />Add node</Button>
		</EmptyState>
	{:else}
		<p class="text-sm text-muted-foreground">
			<span class="font-mono text-foreground tabular-nums">{online}/{data.nodes.length}</span>
			nodes online
		</p>
		<div class="grid gap-4 lg:grid-cols-2">
			{#each data.nodes as node (node.id)}
				{@const capacity = capacityByNode.get(node.id)}
				<Card.Root class="gap-4">
					<Card.Header>
						<div class="flex items-start gap-3">
							<span
								class="relative flex size-10 shrink-0 items-center justify-center rounded-md bg-muted"
							>
								<ServerIcon class="size-[18px] text-muted-foreground" />
								<StatusDot status={node.status} class="absolute -top-0.5 -right-0.5" />
							</span>
							<div class="min-w-0 space-y-1">
								<Card.Title class="flex flex-wrap items-center gap-2">
									{node.name}
									<Badge variant="secondary" class="capitalize">{node.mode}</Badge>
									{#if node.canBuild}
										<Badge variant="brand" class="gap-1">
											<HammerIcon class="size-3" />Builder
										</Badge>
									{/if}
									<StatusBadge status={node.status} />
								</Card.Title>
								<Card.Description class="truncate font-mono text-xs" title={node.id}>
									{node.id}
								</Card.Description>
							</div>
						</div>
						<Card.Action>
							<RowMenu label="Actions for {node.name}">
								<DropdownMenu.Item
									onSelect={() =>
										runAction('?/setDraining', {
											nodeId: node.id,
											draining: node.status === 'draining' ? 'false' : 'true'
										})}
								>
									{#if node.status === 'draining'}
										<CirclePlayIcon />Resume placements
									{:else}
										<CirclePauseIcon />Drain node
									{/if}
								</DropdownMenu.Item>
								<DropdownMenu.Item onSelect={() => copy(node.id)}>
									<CopyIcon />Copy node ID
								</DropdownMenu.Item>
								<DropdownMenu.Separator />
								<DropdownMenu.Item onSelect={() => setBuilder(node)}>
									<HammerIcon />
									{node.canBuild ? 'Remove Builder role' : 'Make this a Builder'}
								</DropdownMenu.Item>
								<DropdownMenu.Separator />
								<DropdownMenu.Item variant="destructive" onSelect={() => rotate(node)}>
									<RefreshCwIcon />Rotate token
								</DropdownMenu.Item>
							</RowMenu>
						</Card.Action>
					</Card.Header>

					<Card.Content class="space-y-4">
						{#if capacity}
							{@const used = capacity.sliceMemoryMb - capacity.freeMemoryMb}
							{@const pct = capacity.sliceMemoryMb > 0 ? (used / capacity.sliceMemoryMb) * 100 : 0}
							<div class="space-y-1.5">
								<div class="flex flex-wrap items-baseline justify-between gap-2 text-xs">
									<span class="text-muted-foreground">
										Workload slice
										<span class="ml-1 font-mono text-xs text-foreground"
											>{capacity.reservedMemoryMb} / {capacity.sliceMemoryMb} MB</span
										>
									</span>
									<span class="font-mono text-xs text-muted-foreground tabular-nums"
										>{capacity.freeMemoryMb} MB free · {capacity.workloadCount} workloads</span
									>
								</div>
								<Progress
									value={Math.min(100, Math.max(0, pct))}
									aria-label="Reserved workload slice memory on {node.name}"
									class="h-1.5"
								/>
							</div>
						{/if}
						<NodeStats stats={node.stats} />
						<DetailList class="border-t">
							<dt>Agent</dt>
							<dd class="font-mono text-xs">
								{node.agentVersion ?? node.version ?? 'not reported'}
							</dd>
							<dt>Address</dt>
							<dd class="font-mono text-xs">{node.publicAddress ?? 'not reported'}</dd>
							<dt>Heartbeat</dt>
							<dd class="text-sm">
								{#if node.lastHeartbeatAt}
									<time datetime={node.lastHeartbeatAt}>{formatDateTime(node.lastHeartbeatAt)}</time
									>
								{:else}
									<span class="text-muted-foreground">never</span>
								{/if}
							</dd>
							<dt>Enrolled</dt>
							<dd class="text-sm">
								<time datetime={node.createdAt}>{formatDateTime(node.createdAt)}</time>
							</dd>
						</DetailList>
						{#if node.stats}
							<Collapsible.Root>
								<Collapsible.Trigger
									class="group inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
								>
									<ChevronRightIcon
										class="size-3 transition-transform group-data-[state=open]:rotate-90"
									/>
									Raw heartbeat stats
								</Collapsible.Trigger>
								<Collapsible.Content>
									<pre
										class="mt-1.5 max-h-56 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs leading-relaxed">{JSON.stringify(
											node.stats,
											null,
											2
										)}</pre>
								</Collapsible.Content>
							</Collapsible.Root>
						{/if}
					</Card.Content>
				</Card.Root>
			{/each}
		</div>

		<Alert.Root>
			<InfoIcon />
			<Alert.Description>
				An agent is marked offline after 30 seconds without a heartbeat and alerts after 2 minutes.
				Draining stops new placements but keeps existing sites and workloads serving. App workloads
				run in <code class="font-mono">skiff-workloads.slice</code>; a Builder node claims one git
				build at a time.
			</Alert.Description>
		</Alert.Root>
	{/if}
</div>

{#if !data.denied}
	<FormDialog
		bind:open={addOpen}
		icon={ServerIcon}
		title="Add a node"
		description="Generate a single-use join command for the machine you want to enrol."
		action="?/createToken"
		submitLabel="Generate join command"
	>
		<ol class="space-y-3 text-sm">
			{#each ['Generate a join command. It works once and expires after one hour.', 'Run it on the new machine, where skiff-agent is installed. It registers the agent with this control plane.', 'The node appears on this page after its first heartbeat, usually within seconds.'] as step, i (i)}
				<li class="flex gap-3">
					<span
						class="grid size-6 shrink-0 place-items-center rounded-full bg-muted font-mono text-xs font-medium"
						>{i + 1}</span
					>
					<span class="pt-0.5 text-muted-foreground">{step}</span>
				</li>
			{/each}
		</ol>
	</FormDialog>
{/if}

{#if result?.command}
	<SecretDialog
		bind:open={commandOpen}
		title="Join command"
		description="Run this on the machine you are enrolling."
		value={result.command}
		multiline
	>
		{#if result.expiresAt}
			<p class="text-xs text-muted-foreground">
				Single-use. Expires <time datetime={result.expiresAt}
					>{formatDateTime(result.expiresAt)}</time
				>.
			</p>
		{/if}
	</SecretDialog>
{/if}

{#if result?.rotatedToken}
	<SecretDialog
		bind:open={tokenOpen}
		title="New token{rotatedNode ? ` for ${rotatedNode.name}` : ''}"
		description="Set SKIFF_NODE_TOKEN in /etc/skiff/agent.env on the node, then restart the agent."
		value={result.rotatedToken}
	/>
{/if}

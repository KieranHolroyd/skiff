<script lang="ts">
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import { resolve } from '$app/paths';
	import type { NodeView } from '@skiff/core';
	import { NODE_STORAGE_DEFAULTS } from '@skiff/contracts';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CirclePauseIcon from '@lucide/svelte/icons/circle-pause';
	import CirclePlayIcon from '@lucide/svelte/icons/circle-play';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import HammerIcon from '@lucide/svelte/icons/hammer';
	import InfoIcon from '@lucide/svelte/icons/info';
	import NetworkIcon from '@lucide/svelte/icons/network';
	import PencilIcon from '@lucide/svelte/icons/pencil';
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
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
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

	let editOpen = $state(false);
	let editing = $state<NodeView | null>(null);
	let editName = $state('');
	let editAddress = $state('');
	let editSliceMemory = $state(1024);
	let editCpuWeight = $state(200);
	let editCanBuild = $state(false);
	let editDataDir = $state('');
	let editBuildDir = $state('');
	const storageChanging = $derived(
		editing !== null &&
			((editDataDir.trim() || null) !== editing.storage.dataDir ||
				(editBuildDir.trim() || null) !== editing.storage.buildDir)
	);

	function edit(node: NodeView) {
		editing = node;
		editName = node.name;
		editAddress = node.publicAddress ?? '';
		editSliceMemory = node.sliceMemoryMb;
		editCpuWeight = node.sliceCpuWeight;
		editCanBuild = node.canBuild;
		editDataDir = node.storage.dataDir ?? '';
		editBuildDir = node.storage.buildDir ?? '';
		editOpen = true;
	}

	/** Requested vs applied storage, for the node card. */
	function storageState(node: NodeView): { tone: 'pending' | 'failed'; text: string } | null {
		const { dataDir, buildDir, status } = node.storage;
		if (!status) {
			if (!dataDir && !buildDir) return null;
			return { tone: 'pending', text: 'Storage move requested; waiting for the node to report.' };
		}
		const current = status.requested.dataDir === dataDir && status.requested.buildDir === buildDir;
		if (current && status.status === 'failed')
			return { tone: 'failed', text: `Storage move failed: ${status.message ?? 'see journalctl -u skiff-storage'}` };
		if (!current || status.status === 'pending')
			return { tone: 'pending', text: status.message ?? 'Storage move in progress.' };
		return null;
	}

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
	const editReserved = $derived(
		editing ? (capacityByNode.get(editing.id)?.reservedMemoryMb ?? 0) : 0
	);

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
				: 'This node will claim git builds one at a time. Builds run in a transient sandboxed unit with a 10-minute cap, so they need skiff-builder.service on the node.',
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
			<Button href={resolve('/(dashboard)/nodes/vpn')} variant="outline">
				<NetworkIcon />
				Worker over WireGuard
			</Button>
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
								<DropdownMenu.Item onSelect={() => edit(node)}>
									<PencilIcon />Edit node
								</DropdownMenu.Item>
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
						{@const storage = storageState(node)}
						{#if storage}
							<p
								class="flex items-start gap-1.5 text-xs {storage.tone === 'failed'
									? 'text-destructive'
									: 'text-muted-foreground'}"
							>
								<HardDriveIcon class="mt-px size-3.5 shrink-0" />{storage.text}
							</p>
						{/if}
						<NodeStats stats={node.stats} />
						<DetailList class="border-t">
							<dt>Agent</dt>
							<dd class="font-mono text-xs">
								{node.agentVersion ?? node.version ?? 'not reported'}
							</dd>
							<dt>Address</dt>
							<dd class="font-mono text-xs">{node.publicAddress ?? 'not reported'}</dd>
							<dt>Data</dt>
							<dd class="truncate font-mono text-xs" title="Release cache and agent state">
								{node.storage.status?.dataDir ?? node.storage.dataDir ?? NODE_STORAGE_DEFAULTS.dataDir}
							</dd>
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
				run in <code class="font-mono">skiff-workloads.slice</code>. Any node can be a Builder: its
				<code class="font-mono">skiff-builder.service</code> claims one git build at a time and idles
				while the role is off.
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
		<p class="text-sm text-muted-foreground">
			Adding a machine behind NAT, like a homelab?
			<a
				href={resolve('/(dashboard)/nodes/vpn')}
				class="font-medium text-foreground underline underline-offset-4"
				>Follow the WireGuard worker guide</a
			>. It sets up the tunnel and generates a join command with the right address.
		</p>
	</FormDialog>
{/if}

{#if !data.denied && editing}
	<FormDialog
		bind:open={editOpen}
		icon={PencilIcon}
		title="Edit {editing.name}"
		description="Changes reach the agent with its next desired-state pull, usually within seconds."
		action="?/updateNode"
		submitLabel="Save node"
		size="lg"
	>
		<input type="hidden" name="nodeId" value={editing.id} />
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="node-name">Name</Field.Label>
					<Input id="node-name" name="name" bind:value={editName} maxlength={120} required />
				</Field.Field>
				<Field.Field>
					<Field.Label for="node-address">Address</Field.Label>
					<Input
						id="node-address"
						name="publicAddress"
						bind:value={editAddress}
						placeholder="10.8.0.2:80"
						class="font-mono text-sm"
					/>
					<Field.Description>
						{editing.mode === 'edge'
							? 'Informational on the edge.'
							: 'host:port the edge proxies to, usually the WireGuard address.'}
					</Field.Description>
				</Field.Field>
			</div>

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="node-slice-memory">Workload slice memory (MB)</Field.Label>
					<Input
						id="node-slice-memory"
						name="sliceMemoryMb"
						type="number"
						min={Math.max(32, editReserved)}
						max="65536"
						bind:value={editSliceMemory}
					/>
					<Field.Description>
						MemoryMax for <code class="font-mono">skiff-workloads.slice</code> and the admission
						budget. {editReserved} MB is reserved by workloads now, so you cannot go below that.
					</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="node-cpu-weight">Workload slice CPU weight</Field.Label>
					<Input
						id="node-cpu-weight"
						name="sliceCpuWeight"
						type="number"
						min="1"
						max="10000"
						bind:value={editCpuWeight}
					/>
					<Field.Description>
						CPUWeight relative to the other slices (systemd default 100). Lower it so the platform
						services win under contention.
					</Field.Description>
				</Field.Field>
			</div>

			<Field.Field orientation="horizontal" class="gap-2">
				<Checkbox id="node-can-build" name="canBuild" value="1" bind:checked={editCanBuild} />
				<Field.Label for="node-can-build" class="font-normal">
					Builder: claim git builds on this node, one at a time
				</Field.Label>
			</Field.Field>
			<Field.Separator />
			<Field.Set>
				<Field.Legend variant="label">Storage</Field.Legend>
				<Field.Description>
					Move this node's data to another disk or partition. Leave a field blank for the default.
					The node copies the data, restarts the agent, then deletes the old copy. Sites keep
					serving throughout.
				</Field.Description>
				<div class="grid gap-4 sm:grid-cols-2">
					<Field.Field>
						<Field.Label for="node-data-dir">Release cache and agent state</Field.Label>
						<Input
							id="node-data-dir"
							name="dataDir"
							bind:value={editDataDir}
							placeholder={NODE_STORAGE_DEFAULTS.dataDir}
							class="font-mono text-sm"
						/>
						<Field.Description>
							What Caddy serves sites from. Use an empty or new directory.
						</Field.Description>
					</Field.Field>
					<Field.Field>
						<Field.Label for="node-build-dir">Build scratch</Field.Label>
						<Input
							id="node-build-dir"
							name="buildDir"
							bind:value={editBuildDir}
							placeholder={NODE_STORAGE_DEFAULTS.buildDir}
							class="font-mono text-sm"
						/>
						<Field.Description>One checkout per running build; nothing is copied.</Field.Description>
					</Field.Field>
				</div>
				{#if storageChanging}
					<p class="text-xs text-muted-foreground">
						Every parent directory must be reachable by the <code class="font-mono">skiff</code> user.
						A move waits for any running build to finish. Needs
						<code class="font-mono">skiff-storage.path</code> on the node.
					</p>
				{/if}
			</Field.Set>

			{#if editCanBuild && editing.mode === 'edge'}
				<p class="text-xs text-muted-foreground">
					Builds on the edge share its CPU and memory with ingress. Each build is capped at 2 GB and
					200% CPU, but a small VPS may still slow down while one runs.
				</p>
			{/if}
		</Field.Group>
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

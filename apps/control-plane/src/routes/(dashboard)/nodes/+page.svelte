<script lang="ts">
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import { resolve } from '$app/paths';
	import type { NodeView } from '@skiff/core';
	import type { NodeRole } from '@skiff/contracts';
	import { NODE_STORAGE_DEFAULTS, compareSemver, parseSemver } from '@skiff/contracts';
	import { invalidateAll } from '$app/navigation';
	import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
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
	import SignpostIcon from '@lucide/svelte/icons/signpost';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
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
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import NodeStats from '../_lib/NodeStats.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import RowMenu from '../_lib/RowMenu.svelte';
	import { formatBytes, formatDateTime } from '../_lib/format.js';
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
	let editZone = $state('default');
	let editRoles = $state<NodeRole[]>([]);
	let editLabels = $state('');
	let editLan = $state('');
	let editCpuBudget = $state('');
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
		editZone = node.zone;
		editRoles = [...node.roles];
		editLabels = Object.entries(node.labels)
			.map(([key, value]) => `${key}=${value}`)
			.join('\n');
		editLan = node.lanEndpoint ?? '';
		editCpuBudget = node.cpuBudgetMillis === null ? '' : String(node.cpuBudgetMillis);
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
			return {
				tone: 'failed',
				text: `Storage move failed: ${status.message ?? 'see journalctl -u skiff-storage'}`
			};
		if (!current || status.status === 'pending')
			return { tone: 'pending', text: status.message ?? 'Storage move in progress.' };
		return null;
	}

	function volumesOf(nodeId: string) {
		return data.volumesByNode[nodeId];
	}

	/** Mounts the node reports that are not adopted yet (D72). */
	function adoptable(nodeId: string) {
		const view = volumesOf(nodeId);
		if (!view?.inventory) return [];
		const taken = new Set(view.volumes.map((volume) => volume.sourceKey));
		return view.inventory.mounts.filter((mount) => !taken.has(mount.sourceKey));
	}

	function setDefaultVolume(nodeId: string, name: string) {
		void runAction('?/defaultVolume', { nodeId, name });
	}

	function removeVolume(nodeId: string, name: string) {
		askConfirm({
			title: `Remove volume “${name}” from Skiff?`,
			description:
				'Only the registration is removed. The filesystem stays mounted and its data is untouched; instances still using it block the removal.',
			confirmLabel: 'Remove volume',
			tone: 'danger',
			action: '?/removeVolume',
			fields: { nodeId, name }
		});
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

	function makeEdge(node: { id: string; name: string }) {
		const current = data.denied ? undefined : data.nodes.find((item) => item.mode === 'edge');
		askConfirm({
			title: `Make ${node.name} the edge node?`,
			description: `${node.name} takes over ingress and serves every static site${current ? `; ${current.name} becomes a worker and keeps the apps and databases already on it` : ''}. Skiff changes the roles only: if ${node.name} is a different machine, point DNS for the platform and content domains at it and give its agent the TLS settings an edge needs (docs/OPS.md).`,
			confirmLabel: 'Make edge',
			tone: 'danger',
			typeToConfirm: node.name,
			action: '?/setEdge',
			fields: { nodeId: node.id }
		});
	}

	function removeNode(node: { id: string; name: string }) {
		askConfirm({
			title: `Remove ${node.name} from Skiff?`,
			description:
				'Its token is revoked at once, its volume registrations are dropped and any builds it claimed go back to the queue. Projects, workloads, databases, storage instances or app volumes still on it block the removal. Nothing on the machine is deleted; uninstall the agent there afterwards.',
			confirmLabel: 'Remove node',
			tone: 'danger',
			typeToConfirm: node.name,
			action: '?/removeNode',
			fields: { nodeId: node.id }
		});
	}

	/** A node update counts as stuck after this long without the new version (core NODE_UPDATE_STALE_MS). */
	const UPDATE_STALE_MS = 15 * 60 * 1000;

	type UpdateState =
		| { kind: 'current' }
		| { kind: 'available'; target: string; selfUpdate: boolean }
		| { kind: 'pending'; target: string; stale: boolean }
		| { kind: 'failed'; target: string; error: string };

	/** Where a node stands against the control plane's release (D99). */
	function updateState(node: NodeView): UpdateState {
		if (node.update?.status === 'pending') {
			const since = node.update.requestedAt ? Date.parse(node.update.requestedAt) : Date.now();
			return { kind: 'pending', target: node.update.version, stale: Date.now() - since > UPDATE_STALE_MS };
		}
		const target = data.denied ? null : parseSemver(data.targetVersion);
		const running = parseSemver(node.agentVersion);
		if (!target || (running && compareSemver(running, target) >= 0)) return { kind: 'current' };
		if (node.update?.status === 'failed')
			return { kind: 'failed', target: target.version, error: node.update.error ?? 'The node reported no reason.' };
		return {
			kind: 'available',
			target: target.version,
			selfUpdate: node.capabilities.includes('node-update')
		};
	}

	function updateAgent(node: NodeView, target: string) {
		askConfirm({
			title: `Update ${node.name} to ${target}?`,
			description: `The node downloads the signed ${target} release from GitHub, checks its signature and checksum, replaces skiff-agent and skiff-helper, and restarts them. Sites and workloads keep running; the node shows offline for a few seconds while its agent restarts.`,
			confirmLabel: 'Update node',
			action: '?/updateAgent',
			fields: { nodeId: node.id }
		});
	}

	// Follow a running update: the agent restarts on the new version within a minute or two.
	const updating = $derived(
		!data.denied && data.nodes.some((node) => node.update?.status === 'pending')
	);
	$effect(() => {
		if (!updating) return;
		const timer = setInterval(() => void invalidateAll(), 5_000);
		return () => clearInterval(timer);
	});

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
		target="page.nodes"
		eyebrow="Infrastructure"
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
			<Button href={`${resolve('/(dashboard)/settings')}#access`} variant="ghost" size="sm"
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
									<Badge variant="outline" class="font-mono text-[11px]">{node.zone}</Badge>
									{#if node.networkMode === 'skiff'}
										<Badge variant="outline" class="font-mono text-[11px]">
											{node.privateAddress ?? 'overlay'}
										</Badge>
									{/if}
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
								{#if node.networkMode === 'skiff' && node.wireguardStatus}
									<p class="text-xs text-muted-foreground">
										{node.wireguardStatus.peers.length} overlay peer
										{node.wireguardStatus.peers.length === 1 ? '' : 's'}
										{#if node.wireguardStatus.peers[0]?.latestHandshakeAt}
											· last handshake {formatDateTime(node.wireguardStatus.peers[0]!.latestHandshakeAt)}
										{/if}
									</p>
								{/if}
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
								{@const nodeUpdate = updateState(node)}
								{#if (nodeUpdate.kind === 'available' && nodeUpdate.selfUpdate) || nodeUpdate.kind === 'failed'}
									<DropdownMenu.Item onSelect={() => updateAgent(node, nodeUpdate.target)}>
										<CircleArrowUpIcon />{nodeUpdate.kind === 'failed' ? 'Retry update' : 'Update node'}
									</DropdownMenu.Item>
								{/if}
								<DropdownMenu.Separator />
								<DropdownMenu.Item onSelect={() => setBuilder(node)}>
									<HammerIcon />
									{node.canBuild ? 'Remove Builder role' : 'Make this a Builder'}
								</DropdownMenu.Item>
								<DropdownMenu.Separator />
								<DropdownMenu.Item variant="destructive" onSelect={() => rotate(node)}>
									<RefreshCwIcon />Rotate token
								</DropdownMenu.Item>
								{#if node.mode !== 'edge' && node.status === 'online'}
									<DropdownMenu.Item onSelect={() => makeEdge(node)}>
										<SignpostIcon />Make this the edge
									</DropdownMenu.Item>
								{/if}
								{#if node.mode !== 'edge'}
									<DropdownMenu.Item variant="destructive" onSelect={() => removeNode(node)}>
										<Trash2Icon />Remove node
									</DropdownMenu.Item>
								{/if}
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
						{@const update = updateState(node)}
						{#if update.kind === 'pending'}
							<p class="flex items-start gap-1.5 text-xs text-muted-foreground">
								{#if update.stale}
									<TriangleAlertIcon class="mt-px size-3.5 shrink-0 text-warning" />
									No answer from the node about {update.target} yet. Check
									<code class="font-mono">journalctl -u skiff-agent -u skiff-helper</code> on it.
								{:else}
									<LoaderCircleIcon class="mt-px size-3.5 shrink-0 animate-spin" />
									Updating to {update.target}: downloading and verifying the signed release, then
									restarting the agent.
								{/if}
							</p>
						{:else if update.kind === 'failed'}
							<p class="flex items-start gap-1.5 text-xs text-destructive">
								<TriangleAlertIcon class="mt-px size-3.5 shrink-0" />
								<span>Update to {update.target} failed: {update.error}</span>
							</p>
						{:else if update.kind === 'available'}
							<div class="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-xs">
								<span class="flex items-center gap-1.5">
									<CircleArrowUpIcon class="size-3.5 shrink-0 text-brand" />
									{#if update.selfUpdate}
										Version {update.target} is available for this node.
									{:else}
										This agent predates dashboard updates. Update it to {update.target} by hand once
										(docs/OPS.md, “Updating worker nodes”); later updates work from here.
									{/if}
								</span>
								{#if update.selfUpdate}
									<Button size="sm" variant="outline" onclick={() => updateAgent(node, update.target)}>
										Update node
									</Button>
								{/if}
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
							<dd class="flex flex-wrap items-center gap-1.5 font-mono text-xs">
								{node.agentVersion ?? node.version ?? 'not reported'}
								{#if update.kind === 'available'}
									<Badge variant="brand">{update.target} available</Badge>
								{:else if update.kind === 'pending'}
									<Badge variant="info">updating to {update.target}</Badge>
								{:else if update.kind === 'failed'}
									<Badge variant="danger">update failed</Badge>
								{/if}
							</dd>
							<dt>Address</dt>
							<dd class="font-mono text-xs">{node.publicAddress ?? 'not reported'}</dd>
							<dt>Data</dt>
							<dd class="truncate font-mono text-xs" title="Release cache and agent state">
								{node.storage.status?.dataDir ??
									node.storage.dataDir ??
									NODE_STORAGE_DEFAULTS.dataDir}
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
						{@const volumeView = volumesOf(node.id)}
						{#if volumeView}
							<div class="space-y-2 border-t pt-3">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium">Volumes</span>
									<span class="text-xs text-muted-foreground">
										{volumeView.volumes.length}
										{volumeView.volumes.length === 1 ? 'volume' : 'volumes'}
									</span>
								</div>
								{#each volumeView.volumes as volume (volume.id)}
									<div class="space-y-1 rounded-md border px-2.5 py-2 text-xs">
										<div class="flex flex-wrap items-center gap-1.5">
											<span class="font-medium">{volume.name}</span>
											<Badge variant="outline" class="font-mono text-[10px]">{volume.class}</Badge>
											{#if volume.isDefault}<Badge variant="info">Default</Badge>{/if}
											{#if volume.remote}<Badge variant="outline">Network</Badge>{/if}
											{#if volume.status !== 'ready'}<StatusBadge status={volume.status} />{/if}
										</div>
										<div class="font-mono text-muted-foreground">
											{volume.mountPath} · {volume.kind} · {formatBytes(volume.freeBytes)} free of
											{formatBytes(volume.sizeBytes)}
										</div>
										{#if volume.instances.storage.length > 0 || volume.instances.databases.length > 0}
											<div class="text-muted-foreground">
												{[
													...volume.instances.storage.map((name) => `storage ${name}`),
													...volume.instances.databases.map((name) => `database ${name}`)
												].join(', ')}
											</div>
										{/if}
										{#if volume.message}
											<div class="text-destructive">{volume.message}</div>
										{/if}
										<div class="flex gap-1 pt-0.5">
											{#if !volume.isDefault}
												<Button
													size="sm"
													variant="ghost"
													onclick={() => setDefaultVolume(node.id, volume.name)}
												>
													Make default
												</Button>
											{/if}
											<Button
												size="sm"
												variant="ghost"
												onclick={() => removeVolume(node.id, volume.name)}
											>
												Remove
											</Button>
										</div>
									</div>
								{/each}
								{#if adoptable(node.id).length > 0}
									<form
										method="POST"
										action="?/adoptVolume"
										class="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
									>
										<input type="hidden" name="nodeId" value={node.id} />
										<Input
											name="name"
											placeholder="volume name"
											required
											minlength={3}
											maxlength={40}
										/>
										<NativeSelect.Root name="sourceKey" required class="w-full">
											{#each adoptable(node.id) as mount (mount.sourceKey)}
												<NativeSelect.Option value={mount.sourceKey}>
													{mount.mountPath} · {mount.fsType} · {formatBytes(mount.freeBytes)} free
												</NativeSelect.Option>
											{/each}
										</NativeSelect.Root>
										<Button type="submit" size="sm">Adopt</Button>
									</form>
								{:else if volumeView.volumes.length === 0}
									<p class="text-xs text-muted-foreground">
										No mounts reported yet. The agent sends its inventory within a minute of
										starting.
									</p>
								{/if}
							</div>
						{/if}
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
				An agent is marked offline after 30 seconds without a heartbeat and alerts after {data.policies.nodeAlertMinutes}
				{data.policies.nodeAlertMinutes === 1 ? 'minute' : 'minutes'} (Settings → Policies).
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
		<Field.Field>
			<Field.Label>Network</Field.Label>
			<div class="space-y-2">
				<label class="flex items-start gap-2 text-sm">
					<input type="radio" name="networkMode" value="skiff" checked class="mt-1 size-4 accent-brand" />
					<span>
						<span class="font-medium">Skiff network (recommended)</span>
						<span class="block text-xs text-muted-foreground">
							The node generates its key locally and dials out; no inbound ports, no IP planning.
						</span>
					</span>
				</label>
				<label class="flex items-start gap-2 text-sm">
					<input type="radio" name="networkMode" value="external" class="mt-1 size-4 accent-brand" />
					<span>
						<span class="font-medium">Existing private network</span>
						<span class="block text-xs text-muted-foreground">
							Use an address the edge already reaches (Tailscale, VPC or LAN); host-provisioned.
						</span>
					</span>
				</label>
			</div>
		</Field.Field>

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
					<Field.Label for="node-zone">Zone</Field.Label>
					<Input id="node-zone" name="zone" bind:value={editZone} placeholder="home" maxlength={32} />
					<Field.Description>
						The failure domain: nodes in one zone share power, uplink and provider fate.
					</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="node-lan-endpoint">LAN endpoint</Field.Label>
					<Input
						id="node-lan-endpoint"
						name="lanEndpoint"
						bind:value={editLan}
						placeholder="192.168.1.20:51820"
						class="font-mono text-sm"
					/>
					<Field.Description>
						Optional private address inside this zone; used for direct peering in C1.
					</Field.Description>
				</Field.Field>
			</div>

			<Field.Field>
				<Field.Label>Roles</Field.Label>
				<div class="flex flex-wrap gap-x-5 gap-y-2">
					{#each ['ingress', 'control', 'compute', 'data', 'build'] as const as role (role)}
						<label class="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								name="roles"
								value={role}
								bind:group={editRoles}
								class="size-4 accent-brand"
							/>
							{role}
						</label>
					{/each}
				</div>
				<Field.Description>
					What this node may run. Removing a role is refused while a workload, database or
					storage instance still uses it.
				</Field.Description>
			</Field.Field>

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="node-labels">Labels</Field.Label>
					<Textarea
						id="node-labels"
						name="labels"
						bind:value={editLabels}
						rows={3}
						placeholder={'tier=critical\nowner=media'}
						class="font-mono text-sm"
					/>
					<Field.Description>
						One key=value per line. Placement constraints can match them; skiff.io/ is reserved.
					</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="node-cpu-budget">CPU budget (millis)</Field.Label>
					<Input
						id="node-cpu-budget"
						name="cpuBudgetMillis"
						type="number"
						min="100"
						max="1000000"
						bind:value={editCpuBudget}
						placeholder="No explicit cap"
					/>
					<Field.Description>
						Optional reservation ceiling for this node's workloads. Blank leaves it uncapped.
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
						<Field.Description>One checkout per running build; nothing is copied.</Field.Description
						>
					</Field.Field>
				</div>
				{#if storageChanging}
					<p class="text-xs text-muted-foreground">
						Every parent directory must be reachable by the <code class="font-mono">skiff</code>
						user. A move waits for any running build to finish. Needs
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

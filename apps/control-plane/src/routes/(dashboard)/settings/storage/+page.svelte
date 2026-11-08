<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import VolumeProfileStats from '#lib/components/skiff/VolumeProfileStats.svelte';
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import NetworkIcon from '@lucide/svelte/icons/network';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ServerIcon from '@lucide/svelte/icons/server';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { DISK_MOUNT_ROOT, type StorageKind, type StorageNodeView, type StoragePartitionView, type StoragePoolView, type VolumeInventoryEntry } from '@skiff/contracts';
	import { notify, runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import { formatBytes } from '../../_lib/format.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const overview = $derived(data.overview);
	const poolNames = $derived(overview.pools.map((pool) => pool.name));

	// Defaults are edited locally, then saved in one form.
	let defaults = $state<Record<string, string>>({});
	$effect(() => {
		defaults = Object.fromEntries(overview.defaults.map((item) => [item.kind, item.pool]));
	});
	let savingDefaults = $state(false);

	// While a benchmark or a partition mount is in flight, refresh so results appear without a reload.
	const profiling = $derived(
		overview.pools.some((pool) => pool.profiling) ||
			overview.nodes.some(
				(node) =>
					node.volumes.some((volume) => volume.profile?.status === 'queued' || volume.profile?.status === 'running') ||
					node.partitions.some((part) => part.state === 'mounting' || part.state === 'unmounting'),
			)
	);
	$effect(() => {
		if (!profiling) return;
		const timer = setInterval(() => void invalidateAll(), 4_000);
		return () => clearInterval(timer);
	});

	function profilePool(pool: StoragePoolView) {
		askConfirm({
			title: `Profile pool “${pool.name}”?`,
			description: `Benchmarks each volume in turn: sequential read and write, random 4 KiB read and write IOPS, and sync-write latency. Each takes about a minute, writes a ${512} MiB scratch file it deletes afterwards, and loads the disk heavily while it runs, so pick a quiet moment.`,
			confirmLabel: 'Start profiling',
			action: '?/profilePool',
			fields: { name: pool.name },
		});
	}

	/** Fill the defaults from pool classes: fast pools for databases, bulk pools for big data. */
	function suggest() {
		const fast = overview.pools.find((pool) => pool.classes.includes('fast') && !pool.classes.includes('remote'))?.name;
		const bulk =
			overview.pools.find((pool) => pool.classes.includes('bulk'))?.name ??
			overview.pools.find((pool) => pool.classes.includes('remote'))?.name;
		const localBulk = overview.pools.find((pool) => pool.classes.includes('bulk') && !pool.classes.includes('remote'))?.name;
		const plan: Record<StorageKind, string> = {
			databases: fast ?? 'system',
			brokers: fast ?? 'system',
			'app-volumes': fast ?? 'system',
			'object-storage': bulk ?? fast ?? 'system',
			builds: localBulk ?? 'system',
			'site-data': 'system',
		};
		defaults = plan;
	}

	// Pool dialogs
	let createOpen = $state(false);
	let editOpen = $state(false);
	let editing = $state<StoragePoolView | null>(null);
	let adoptOpen = $state(false);
	let adopting = $state<{ nodeId: string; nodeName: string; mount: VolumeInventoryEntry } | null>(null);
	let mountOpen = $state(false);
	let mountingPart = $state<{ nodeId: string; nodeName: string; part: StoragePartitionView } | null>(null);

	/** Mounts the node reports that are not a listed partition (network shares, ZFS datasets, …). */
	function otherMounts(node: StorageNodeView): VolumeInventoryEntry[] {
		const shown = new Set(node.partitions.map((part) => part.mountPath).filter(Boolean));
		return node.adoptable.filter((mount) => !shown.has(mount.mountPath));
	}

	/** *Add as volume*: adopt a mounted partition, or mount an unmounted one first. */
	function addPartition(node: StorageNodeView, part: StoragePartitionView) {
		if (part.state === 'adoptable') {
			const mount = node.adoptable.find((item) => item.sourceKey === part.sourceKey);
			if (!mount) return;
			adopting = { nodeId: node.id, nodeName: node.name, mount };
			adoptOpen = true;
			return;
		}
		mountingPart = { nodeId: node.id, nodeName: node.name, part };
		mountOpen = true;
	}

	function unmountPartition(node: StorageNodeView, part: StoragePartitionView) {
		if (!part.diskMountId) return;
		askConfirm({
			title: part.state === 'volume' ? `Remove volume “${part.volumeName}” and unmount ${part.device}?` : `Unmount ${part.device}?`,
			description:
				part.state === 'volume'
					? 'The volume is unregistered first, which is refused while anything is stored on it. The partition is then unmounted on the node; its files stay on the disk.'
					: 'The node stops mounting it. Its files stay on the disk.',
			confirmLabel: 'Unmount',
			tone: 'danger',
			action: '?/unmountPartition',
			fields: { nodeId: node.id, id: part.diskMountId },
		});
	}

	const partitionBadge: Record<string, { label: string; tone: 'success' | 'info' | 'warning' | 'neutral' | 'danger' | 'outline' }> = {
		mounting: { label: 'Mounting…', tone: 'info' },
		failed: { label: 'Mount failed', tone: 'danger' },
		unmounting: { label: 'Unmounting…', tone: 'neutral' },
		system: { label: 'System', tone: 'neutral' },
		'in-use': { label: 'In use', tone: 'neutral' },
		unformatted: { label: 'No filesystem', tone: 'outline' },
		unsupported: { label: 'Not supported', tone: 'outline' },
	};

	const unassigned = $derived(
		overview.nodes.flatMap((node) =>
			node.volumes.filter((volume) => !volume.pool).map((volume) => ({ ...volume, nodeName: node.name })),
		),
	);

	function suggestedPool(cls: string, remote: boolean): string {
		const want = remote ? 'nas' : cls === 'fast' ? 'ssd' : cls === 'bulk' ? 'hdd' : '';
		return poolNames.includes(want) ? want : '';
	}

	function usage(pool: StoragePoolView): number {
		return pool.sizeBytes > 0 ? Math.round(((pool.sizeBytes - pool.freeBytes) / pool.sizeBytes) * 100) : 0;
	}

	function adoptName(mount: VolumeInventoryEntry): string {
		const last = mount.mountPath.split('/').filter(Boolean).at(-1) ?? 'data';
		return last.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').padEnd(3, '0').slice(0, 40);
	}

	function assign(volumeId: string, pool: string) {
		void runAction('?/assignVolume', { volumeId, pool });
	}

	function removePool(pool: StoragePoolView) {
		askConfirm({
			title: `Delete pool “${pool.name}”?`,
			description: 'Its volumes become unassigned. Nothing placed on them moves or is deleted.',
			confirmLabel: 'Delete pool',
			tone: 'danger',
			action: '?/deletePool',
			fields: { name: pool.name },
		});
	}

	const classTone: Record<string, 'success' | 'info' | 'warning' | 'neutral'> = {
		fast: 'success',
		bulk: 'info',
		remote: 'warning',
		unknown: 'neutral',
	};
</script>

<SettingsHeader
	id="storage"
	description="Group disks and network shares into pools. Each service is stored on the pool chosen when it is created; the defaults below are what the create forms preselect. Nothing already created moves."
/>

{#if data.onboarding}
	<Alert.Root class="mb-5">
		<SparklesIcon />
		<Alert.Title>Set up storage before you deploy</Alert.Title>
		<Alert.Description>
			<ol class="mt-1 list-decimal space-y-0.5 pl-4">
				<li>Mount extra disks on your nodes (or add a <a class="underline" href={resolve('/(dashboard)/settings/shares')}>network share</a>) and adopt them below.</li>
				<li>Group them into pools, for example <code>ssd</code> for NVMe and <code>hdd</code> for an array.</li>
				<li>Pick the default pool for each kind of service, then <strong>Save and finish</strong>. You can still choose another pool whenever you create a service.</li>
			</ol>
			<form method="POST" action="?/skipOnboarding" class="mt-3" use:enhance>
				<Button type="submit" variant="outline" size="sm">Use the system disk for now</Button>
			</form>
		</Alert.Description>
	</Alert.Root>
{/if}

<!-- 1. Default storage ---------------------------------------------------------------- -->
<Panel
	title="Default storage"
	icon={LayersIcon}
	description="The pool each kind of service starts with. You choose the storage when you create a service; this is what the form preselects. Changing a default never moves anything already created."
	class="mb-5"
	flush
>
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={suggest} disabled={overview.pools.length === 0}>
			<SparklesIcon />Suggest from pools
		</Button>
	{/snippet}
	<form
		method="POST"
		action="?/saveDefaults"
		use:enhance={() => {
			savingDefaults = true;
			return async ({ result, update }) => {
				savingDefaults = false;
				notify(result);
				await update({ reset: false });
			};
		}}
	>
		<div class="overflow-x-auto">
			<table class="w-full text-sm">
				<thead class="text-left text-xs uppercase tracking-wide text-muted-foreground">
					<tr class="border-b">
						<th class="px-4 py-2">Service</th>
						<th class="px-4 py-2">Default pool</th>
					</tr>
				</thead>
				<tbody>
					{#each overview.defaults as item (item.kind)}
						{#if defaults[item.kind] !== undefined}
							<tr class="border-b align-top last:border-0">
								<td class="px-4 py-3">
									<div class="font-medium">{item.label}</div>
									<div class="text-xs text-muted-foreground">{item.description}</div>
									{#each item.warnings as warning (warning)}
										<div class="mt-1 flex items-start gap-1 text-xs text-warning">
											<TriangleAlertIcon class="mt-0.5 size-3 shrink-0" />{warning}
										</div>
									{/each}
									{#if !item.configured}
										<div class="mt-1 text-xs text-muted-foreground">Not set yet: each node's default volume, else its system disk.</div>
									{/if}
								</td>
								<td class="px-4 py-3">
									<NativeSelect.Root name="{item.kind}.pool" class="w-40" bind:value={defaults[item.kind]}>
										<NativeSelect.Option value="system">System disk</NativeSelect.Option>
										{#each poolNames as name (name)}<NativeSelect.Option value={name}>{name}</NativeSelect.Option>{/each}
									</NativeSelect.Root>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
		<div class="flex flex-wrap justify-end gap-2 border-t px-4 py-3">
			{#if data.onboarding}
				<Button type="submit" variant="outline" size="sm" disabled={savingDefaults}>Save defaults</Button>
				<Button type="submit" name="finish" value="1" size="sm" disabled={savingDefaults}>
					Save and finish<ArrowRightIcon />
				</Button>
			{:else}
				<Button type="submit" size="sm" disabled={savingDefaults}>Save defaults</Button>
			{/if}
		</div>
	</form>
</Panel>

<!-- 2. Pools ----------------------------------------------------------------------- -->
<Panel
	title="Pools"
	icon={DatabaseIcon}
	count={overview.pools.length}
	description="A pool is a named tier of volumes, on one node or many. The system disk of every node is the built-in “system” pool."
	class="mb-5"
>
	{#snippet actions()}
		<Button size="sm" onclick={() => (createOpen = true)}><PlusIcon />New pool</Button>
	{/snippet}
	{#if overview.pools.length === 0}
		<p class="text-sm text-muted-foreground">
			No pools yet, so everything uses each node's system disk. Adopt a disk below, then create a pool such as
			<code>ssd</code> or <code>hdd</code>.
		</p>
	{:else}
		<div class="grid gap-3 md:grid-cols-2">
			{#each overview.pools as pool (pool.id)}
				<div class="space-y-2 rounded-lg border p-3">
					<div class="flex items-start justify-between gap-2">
						<div class="min-w-0">
							<div class="flex flex-wrap items-center gap-1.5 font-medium">
								{pool.name}
								{#each pool.classes as cls (cls)}<Badge variant={classTone[cls] ?? 'neutral'}>{cls}</Badge>{/each}
							</div>
							{#if pool.description}<div class="text-xs text-muted-foreground">{pool.description}</div>{/if}
						</div>
						<div class="flex shrink-0 gap-1">
							<Button
								variant="outline"
								size="xs"
								disabled={pool.profiling || pool.members.length === 0}
								onclick={() => profilePool(pool)}
							>
								<GaugeIcon class="size-3.5" />{pool.profiling ? 'Profiling…' : 'Profile'}
							</Button>
							<Button variant="ghost" size="xs" onclick={() => ((editing = pool), (editOpen = true))}>Edit</Button>
							<Button variant="ghost" size="xs" aria-label="Delete pool" onclick={() => removePool(pool)}>
								<Trash2Icon class="size-3.5" />
							</Button>
						</div>
					</div>
					<div class="h-1.5 overflow-hidden rounded-full bg-muted" title="{usage(pool)}% used">
						<div class="h-full bg-brand" style="width: {usage(pool)}%"></div>
					</div>
					<div class="text-xs text-muted-foreground">
						{formatBytes(pool.freeBytes)} free of {formatBytes(pool.sizeBytes)} · {pool.allocation} · keep {pool.minFreePercent}% free
						{#if pool.usedBy.length}· used by {pool.usedBy.join(', ')}{/if}
					</div>
					{#if pool.members.length === 0}
						<p class="text-xs text-warning">No volumes yet: nothing can be placed here.</p>
					{:else}
						<ul class="space-y-2 text-xs">
							{#each pool.members as member (member.volumeId)}
								<li class="space-y-1">
									<div class="flex flex-wrap items-center gap-1.5">
										<span class="font-medium">{member.nodeName ?? member.nodeId}</span>
										<span class="text-muted-foreground">/</span>
										<span>{member.volumeName}</span>
										<span class="font-mono text-muted-foreground">{member.mountPath}</span>
										{#if member.status !== 'ready'}<Badge variant="danger">{member.status}</Badge>{/if}
										<span class="ml-auto text-muted-foreground">{formatBytes(member.freeBytes)} free</span>
									</div>
									<VolumeProfileStats profile={member.profile} />
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</Panel>

<!-- 3. Nodes and volumes ---------------------------------------------------------- -->
<Panel
	title="Disks and volumes"
	icon={ServerIcon}
	description="Every partition each node reports. Add as volume adopts a mounted partition, or first mounts an unmounted ext4, xfs, btrfs or f2fs filesystem at {DISK_MOUNT_ROOT}/<name> by its UUID. Then put it in a pool. Skiff never formats or deletes anything here."
	class="mb-5"
>
	{#snippet actions()}
		<Button variant="outline" size="sm" href={resolve('/(dashboard)/settings/shares')}><NetworkIcon />Network shares</Button>
	{/snippet}
	<div class="space-y-4">
		{#each overview.nodes as node (node.id)}
			<div class="space-y-2">
				<div class="flex flex-wrap items-center gap-2 text-sm">
					<ServerIcon class="size-4 text-muted-foreground" />
					<span class="font-medium">{node.name}</span>
					<Badge variant="outline">{node.status}</Badge>
					<span class="text-xs text-muted-foreground">
						System disk: {formatBytes(node.systemFreeBytes)} free{node.systemSizeBytes ? ` of ${formatBytes(node.systemSizeBytes)}` : ''}
					</span>
				</div>
				{#if node.volumes.length === 0 && node.adoptable.length === 0 && node.partitions.length === 0}
					<p class="pl-6 text-xs text-muted-foreground">
						Only the system disk.{node.freeDevices
							? ` ${node.freeDevices} unformatted disk(s) detected: format and mount them on the node, and they appear here.`
							: ''}
					</p>
				{/if}
				{#each node.volumes as volume (volume.id)}
					<div class="ml-6 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
						<HardDriveIcon class="size-3.5 text-muted-foreground" />
						<span class="font-medium">{volume.name}</span>
						<Badge variant={classTone[volume.class] ?? 'neutral'}>{volume.class}</Badge>
						{#if volume.remote}<Badge variant="outline">network</Badge>{/if}
						{#if volume.status !== 'ready'}<Badge variant="danger">{volume.status}</Badge>{/if}
						<span class="font-mono text-xs text-muted-foreground">{volume.mountPath}</span>
						<span class="text-xs text-muted-foreground">{formatBytes(volume.freeBytes)} free of {formatBytes(volume.sizeBytes)}</span>
						<Button
							variant="ghost"
							size="xs"
							class="ml-auto"
							disabled={volume.status !== 'ready' || volume.profile?.status === 'queued' || volume.profile?.status === 'running'}
							onclick={() => void runAction('?/profileVolume', { volumeId: volume.id })}
						>
							<GaugeIcon class="size-3.5" />Profile
						</Button>
						<NativeSelect.Root
							class="w-36"
							value={volume.pool ?? ''}
							aria-label="Pool for {volume.name}"
							onchange={(event) => assign(volume.id, (event.currentTarget as HTMLSelectElement).value)}
						>
							<NativeSelect.Option value="">No pool</NativeSelect.Option>
							{#each poolNames as name (name)}<NativeSelect.Option value={name}>{name}</NativeSelect.Option>{/each}
						</NativeSelect.Root>
						{#if volume.profile}<div class="basis-full pl-5"><VolumeProfileStats profile={volume.profile} /></div>{/if}
					</div>
				{/each}
				{#if node.partitions.length > 0}
					<div class="ml-6 overflow-x-auto rounded-md border">
						<table class="w-full text-sm">
							<thead class="text-left text-xs uppercase tracking-wide text-muted-foreground">
								<tr class="border-b">
									<th class="px-3 py-2">Partition</th>
									<th class="px-3 py-2">Size</th>
									<th class="px-3 py-2">Filesystem</th>
									<th class="px-3 py-2">Mounted at</th>
									<th class="px-3 py-2 text-right"><span class="sr-only">Action</span></th>
								</tr>
							</thead>
							<tbody>
								{#each node.partitions as part (part.device)}
									<tr class="border-b align-top last:border-0">
										<td class="px-3 py-2">
											<div class="flex items-center gap-1.5">
												<HardDriveIcon class="size-3.5 shrink-0 text-muted-foreground" />
												<span class="font-mono text-xs">{part.device}</span>
												{#if part.type && part.type !== 'part'}<Badge variant="outline">{part.type}</Badge>{/if}
											</div>
											{#if part.label || part.model}
												<div class="pl-5 text-xs text-muted-foreground">{[part.label, part.model].filter(Boolean).join(' · ')}</div>
											{/if}
											{#if part.reason}
												<div class="max-w-md pl-5 text-xs {part.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}">{part.reason}</div>
											{/if}
										</td>
										<td class="whitespace-nowrap px-3 py-2 text-xs">
											{formatBytes(part.sizeBytes)}
											{#if part.freeBytes !== null}<div class="text-muted-foreground">{formatBytes(part.freeBytes)} free</div>{/if}
										</td>
										<td class="px-3 py-2 text-xs">{part.fsType ?? '—'}</td>
										<td class="px-3 py-2 font-mono text-xs text-muted-foreground">{part.mountPath ?? '—'}</td>
										<td class="px-3 py-2">
											<div class="flex flex-wrap items-center justify-end gap-1.5">
												{#if part.state === 'volume'}
													<Badge variant="success">Volume {part.volumeName}</Badge>
												{:else if part.state === 'adoptable' || part.state === 'mountable'}
													<Button variant="outline" size="xs" onclick={() => addPartition(node, part)}>
														<PlusIcon class="size-3.5" />Add as volume
													</Button>
												{:else}
													<Badge variant={partitionBadge[part.state]?.tone ?? 'neutral'}>{partitionBadge[part.state]?.label ?? part.state}</Badge>
												{/if}
												{#if part.diskMountId && part.state !== 'unmounting'}
													<Button variant="ghost" size="xs" onclick={() => unmountPartition(node, part)}>
														{part.state === 'mounting' || part.state === 'failed' ? 'Cancel' : 'Unmount'}
													</Button>
												{/if}
											</div>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
				{#each otherMounts(node) as mount (mount.sourceKey)}
					<div class="ml-6 flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm">
						<HardDriveIcon class="size-3.5 text-muted-foreground" />
						<span class="font-mono text-xs">{mount.mountPath}</span>
						<Badge variant="outline">{mount.kind}</Badge>
						<span class="text-xs text-muted-foreground">{mount.device ?? mount.sourceKey} · {formatBytes(mount.freeBytes)} free of {formatBytes(mount.sizeBytes)}</span>
						<Button
							variant="outline"
							size="xs"
							class="ml-auto"
							onclick={() => ((adopting = { nodeId: node.id, nodeName: node.name, mount }), (adoptOpen = true))}
						>
							Adopt
						</Button>
					</div>
				{/each}
			</div>
		{/each}
	</div>
</Panel>

{#if data.shares.length > 0}
	<Panel title="Network shares" icon={NetworkIcon} count={data.shares.length} description="NFS and SMB shares. A mounted, linked share appears above as a volume on its node.">
		<ul class="space-y-1 text-sm">
			{#each data.shares as share (share.name)}
				<li class="flex flex-wrap items-center gap-2">
					<span class="font-medium">{share.name}</span>
					<Badge variant="outline" class="uppercase">{share.protocol}</Badge>
					<span class="font-mono text-xs text-muted-foreground">{share.server}:{share.exportPath}</span>
					<span class="text-xs text-muted-foreground">mounted on {share.mounts} node(s)</span>
				</li>
			{/each}
		</ul>
	</Panel>
{/if}

<!-- Dialogs ------------------------------------------------------------------------- -->
<FormDialog bind:open={createOpen} icon={DatabaseIcon} title="New pool" description="Name a tier and pick the volumes in it. Volumes can be on different nodes." action="?/createPool" submitLabel="Create pool">
	<Field.Group>
		<div class="grid gap-4 sm:grid-cols-2">
			<Field.Field>
				<Field.Label for="pool-name">Name</Field.Label>
				<Input id="pool-name" name="name" required maxlength={40} placeholder="ssd" class="font-mono text-sm" />
			</Field.Field>
			<Field.Field>
				<Field.Label for="pool-description">Description</Field.Label>
				<Input id="pool-description" name="description" maxlength={200} placeholder="NVMe on every node" />
			</Field.Field>
		</div>
		<div class="grid gap-4 sm:grid-cols-2">
			<Field.Field>
				<Field.Label for="pool-allocation">Allocation</Field.Label>
				<NativeSelect.Root id="pool-allocation" name="allocation" class="w-full">
					<NativeSelect.Option value="most-free">Most free (spread)</NativeSelect.Option>
					<NativeSelect.Option value="fill-up">Fill up (one disk at a time)</NativeSelect.Option>
				</NativeSelect.Root>
			</Field.Field>
			<Field.Field>
				<Field.Label for="pool-minfree">Keep free (%)</Field.Label>
				<Input id="pool-minfree" name="minFreePercent" type="number" min={0} max={90} value="10" />
			</Field.Field>
		</div>
		<Field.Field>
			<Field.Label>Volumes</Field.Label>
			{#if unassigned.length === 0}
				<p class="text-xs text-muted-foreground">No unassigned volumes. Adopt a disk first, or create the pool empty.</p>
			{:else}
				<div class="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
					{#each unassigned as volume (volume.id)}
						<label class="flex items-center gap-2 text-sm">
							<input type="checkbox" name="volumes" value={volume.id} class="size-4 accent-brand" />
							<span class="font-medium">{volume.nodeName}</span>/<span>{volume.name}</span>
							<Badge variant={classTone[volume.class] ?? 'neutral'}>{volume.class}</Badge>
							<span class="ml-auto text-xs text-muted-foreground">{formatBytes(volume.sizeBytes)}</span>
						</label>
					{/each}
				</div>
			{/if}
		</Field.Field>
	</Field.Group>
</FormDialog>

{#if editing}
	<FormDialog bind:open={editOpen} icon={DatabaseIcon} title="Edit {editing.name}" action="?/updatePool" submitLabel="Save pool">
		<input type="hidden" name="name" value={editing.name} />
		<Field.Group>
			<Field.Field>
				<Field.Label for="edit-description">Description</Field.Label>
				<Input id="edit-description" name="description" maxlength={200} value={editing.description} />
			</Field.Field>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="edit-allocation">Allocation</Field.Label>
					<NativeSelect.Root id="edit-allocation" name="allocation" class="w-full" value={editing.allocation}>
						<NativeSelect.Option value="most-free">Most free (spread)</NativeSelect.Option>
						<NativeSelect.Option value="fill-up">Fill up (one disk at a time)</NativeSelect.Option>
					</NativeSelect.Root>
				</Field.Field>
				<Field.Field>
					<Field.Label for="edit-minfree">Keep free (%)</Field.Label>
					<Input id="edit-minfree" name="minFreePercent" type="number" min={0} max={90} value={String(editing.minFreePercent)} />
				</Field.Field>
			</div>
		</Field.Group>
	</FormDialog>
{/if}

{#if mountingPart}
	<FormDialog
		bind:open={mountOpen}
		icon={HardDriveIcon}
		title="Add {mountingPart.part.device} as a volume"
		description="{mountingPart.nodeName} mounts this {mountingPart.part.fsType} filesystem by its UUID at {DISK_MOUNT_ROOT}/<name> and keeps it mounted across reboots, then it becomes a volume. Nothing is formatted; Skiff only creates its own skiff/ directory inside."
		action="?/mountPartition"
		submitLabel="Add as volume"
	>
		<input type="hidden" name="nodeId" value={mountingPart.nodeId} />
		<input type="hidden" name="fsUuid" value={mountingPart.part.uuid} />
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="mount-name">Volume name</Field.Label>
					<Input id="mount-name" name="name" required minlength={3} maxlength={40} value={mountingPart.part.suggestedName} class="font-mono text-sm" />
					<Field.Description>Mounted at <code>{DISK_MOUNT_ROOT}/&lt;name&gt;</code>.</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="mount-pool">Pool</Field.Label>
					<NativeSelect.Root id="mount-pool" name="pool" class="w-full" value={suggestedPool(/nvme/i.test(mountingPart.part.device) ? 'fast' : '', false)}>
						<NativeSelect.Option value="">No pool yet</NativeSelect.Option>
						{#each poolNames as name (name)}<NativeSelect.Option value={name}>{name}</NativeSelect.Option>{/each}
					</NativeSelect.Root>
				</Field.Field>
			</div>
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" name="defaultVolume" value="1" class="size-4 accent-brand" />
				Make it {mountingPart.nodeName}'s default volume for new services
			</label>
		</Field.Group>
	</FormDialog>
{/if}

{#if adopting}
	<FormDialog
		bind:open={adoptOpen}
		icon={HardDriveIcon}
		title="Adopt {adopting.mount.mountPath}"
		description="Registers this mount on {adopting.nodeName} as a volume. Nothing is formatted; Skiff only creates its own skiff/ directory inside."
		action="?/adopt"
		submitLabel="Adopt volume"
	>
		<input type="hidden" name="nodeId" value={adopting.nodeId} />
		<input type="hidden" name="sourceKey" value={adopting.mount.sourceKey} />
		<div class="grid gap-4 sm:grid-cols-2">
			<Field.Field>
				<Field.Label for="adopt-name">Volume name</Field.Label>
				<Input id="adopt-name" name="name" required maxlength={40} value={adoptName(adopting.mount)} class="font-mono text-sm" />
			</Field.Field>
			<Field.Field>
				<Field.Label for="adopt-pool">Pool</Field.Label>
				<NativeSelect.Root id="adopt-pool" name="pool" class="w-full" value={suggestedPool(/nvme/i.test(adopting.mount.device ?? '') ? 'fast' : '', adopting.mount.remote)}>
					<NativeSelect.Option value="">No pool yet</NativeSelect.Option>
					{#each poolNames as name (name)}<NativeSelect.Option value={name}>{name}</NativeSelect.Option>{/each}
				</NativeSelect.Root>
			</Field.Field>
		</div>
	</FormDialog>
{/if}

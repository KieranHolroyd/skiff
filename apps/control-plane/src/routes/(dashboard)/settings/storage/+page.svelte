<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import NetworkIcon from '@lucide/svelte/icons/network';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ServerIcon from '@lucide/svelte/icons/server';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import {
		DISK_MOUNT_ROOT,
		storageKindInfo,
		storageTierInfo,
		type DiskCandidateView,
		type DiskView,
		type StorageDefaultTarget,
		type StorageNodeView,
		type StorageTier
	} from '@yoal/contracts';
	import { notify, runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import VolumeProfileStats from '#lib/components/yoal/VolumeProfileStats.svelte';
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

	// Defaults are edited locally, then saved in one form.
	let defaults = $state<Record<string, StorageDefaultTarget>>({});
	$effect(() => {
		defaults = Object.fromEntries(overview.defaults.map((item) => [item.kind, item.target]));
	});
	let savingDefaults = $state(false);

	/** Fill the defaults from each kind's suggestion, using only tiers that have a disk. */
	function suggest() {
		const has = (tier: StorageTier) => overview.tiers[tier].disks > 0;
		const pick = (want: StorageDefaultTarget): StorageDefaultTarget => {
			if (want === 'system' || has(want)) return want;
			const other: StorageTier = want === 'fast' ? 'bulk' : 'fast';
			return has(other) ? other : 'system';
		};
		defaults = Object.fromEntries(
			overview.defaults.map((item) => [item.kind, pick(storageKindInfo[item.kind].suggested)])
		);
	}

	// While a mount, an unmount or a benchmark is in flight, refresh so the result appears.
	const busy = $derived(
		overview.nodes.some((node) =>
			node.disks.some(
				(disk) =>
					disk.status === 'pending' ||
					disk.status === 'removing' ||
					disk.profile?.status === 'queued' ||
					disk.profile?.status === 'running'
			)
		)
	);
	$effect(() => {
		if (!busy) return;
		const timer = setInterval(() => void invalidateAll(), 4_000);
		return () => clearInterval(timer);
	});

	// Dialogs
	let addOpen = $state(false);
	let adding = $state<{ node: StorageNodeView; candidate: DiskCandidateView } | null>(null);
	let editOpen = $state(false);
	let editing = $state<DiskView | null>(null);

	function openAdd(node: StorageNodeView, candidate: DiskCandidateView) {
		adding = { node, candidate };
		addOpen = true;
	}

	function openEdit(disk: DiskView) {
		editing = disk;
		editOpen = true;
	}

	function remove(disk: DiskView) {
		askConfirm({
			title: `Stop using “${disk.name}”?`,
			description: disk.mountedByYoal
				? `Yoal unmounts ${disk.mountPath} on ${disk.nodeName ?? 'its node'}. The files on the disk stay.`
				: `Yoal forgets the disk. It stays mounted at ${disk.mountPath} and its files stay.`,
			confirmLabel: 'Remove disk',
			tone: 'danger',
			action: '?/removeDisk',
			fields: { id: disk.id }
		});
	}

	function profile(disk: DiskView) {
		askConfirm({
			title: `Benchmark “${disk.name}”?`,
			description:
				'Measures sequential and random read and write speed and sync-write latency, which tells you whether it is a fast or a bulk disk. It writes a 512 MiB scratch file it deletes afterwards and loads the disk heavily for about a minute.',
			confirmLabel: 'Start benchmark',
			action: '?/profileDisk',
			fields: { id: disk.id }
		});
	}

	function usedPercent(disk: { sizeBytes: number | null; freeBytes: number | null }): number {
		if (!disk.sizeBytes || disk.freeBytes === null) return 0;
		return Math.round(((disk.sizeBytes - disk.freeBytes) / disk.sizeBytes) * 100);
	}

	const tierTone: Record<StorageTier, 'success' | 'info'> = { fast: 'success', bulk: 'info' };
	const statusLabel: Record<string, { label: string; tone: 'info' | 'danger' | 'neutral' }> = {
		pending: { label: 'Mounting…', tone: 'info' },
		removing: { label: 'Unmounting…', tone: 'neutral' },
		missing: { label: 'Missing', tone: 'danger' },
		failed: { label: 'Mount failed', tone: 'danger' }
	};

	function tierCount(tier: StorageTier): string {
		const count = overview.tiers[tier].disks;
		return count === 0 ? 'none yet' : `${count} disk${count === 1 ? '' : 's'}`;
	}
</script>

<SettingsHeader
	id="storage"
	description="Where services keep their data. Every node has its system disk; add more disks below and mark each one fast or bulk. The defaults decide which one each kind of service uses. Nothing already created moves."
/>

{#if data.onboarding}
	<Alert.Root class="mb-5">
		<SparklesIcon />
		<Alert.Title>Set up storage before you deploy</Alert.Title>
		<Alert.Description>
			<ol class="mt-1 list-decimal space-y-0.5 pl-4">
				<li>
					Under each node, press <strong>Use this disk</strong> on the disks Yoal should store data on.
				</li>
				<li>
					Check each disk is marked <strong>fast</strong> (SSD, NVMe) or <strong>bulk</strong> (spinning
					disks, arrays, a NAS).
				</li>
				<li>
					Press <strong>Suggest</strong> (or pick the defaults yourself), then
					<strong>Save and finish</strong>.
				</li>
			</ol>
			<form method="POST" action="?/skipOnboarding" class="mt-3" use:enhance>
				<Button type="submit" variant="outline" size="sm">Use the system disk for now</Button>
			</form>
		</Alert.Description>
	</Alert.Root>
{/if}

<!-- 1. Defaults ------------------------------------------------------------------------- -->
<Panel
	title="Defaults"
	icon={LayersIcon}
	description="Which storage each kind of service starts on. The create form preselects it; each service can still pick another."
	class="mb-5"
	flush
>
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={suggest}><SparklesIcon />Suggest</Button>
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
		<ul class="divide-y">
			{#each overview.defaults as item (item.kind)}
				{#if defaults[item.kind] !== undefined}
					<li class="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
						<div class="min-w-0 flex-1">
							<div class="text-sm font-medium">{item.label}</div>
							<div class="text-xs text-muted-foreground">{item.description}</div>
							{#each item.warnings as warning (warning)}
								<div class="mt-1 flex items-start gap-1 text-xs text-warning">
									<TriangleAlertIcon class="mt-0.5 size-3 shrink-0" />{warning}
								</div>
							{/each}
						</div>
						<NativeSelect.Root
							name="{item.kind}.target"
							class="w-48"
							bind:value={defaults[item.kind]}
							aria-label="Default storage for {item.label}"
						>
							<NativeSelect.Option value="system"
								>{storageTierInfo.system.label}</NativeSelect.Option
							>
							<NativeSelect.Option value="fast"
								>{storageTierInfo.fast.label} · {tierCount('fast')}</NativeSelect.Option
							>
							<NativeSelect.Option value="bulk"
								>{storageTierInfo.bulk.label} · {tierCount('bulk')}</NativeSelect.Option
							>
						</NativeSelect.Root>
					</li>
				{/if}
			{/each}
		</ul>
		<div class="flex flex-wrap justify-end gap-2 border-t px-4 py-3">
			{#if data.onboarding}
				<Button type="submit" variant="outline" size="sm" disabled={savingDefaults}
					>Save defaults</Button
				>
				<Button type="submit" name="finish" value="1" size="sm" disabled={savingDefaults}>
					Save and finish<ArrowRightIcon />
				</Button>
			{:else}
				<Button type="submit" size="sm" disabled={savingDefaults}>Save defaults</Button>
			{/if}
		</div>
	</form>
</Panel>

<!-- 2. Disks per node ------------------------------------------------------------------- -->
<Panel
	title="Disks"
	icon={HardDriveIcon}
	count={overview.nodes.reduce((sum, node) => sum + node.disks.length, 0)}
	description="Yoal only uses filesystems the node already has. It never formats a disk, and it only writes inside its own yoal/ directory."
	class="mb-5"
>
	{#snippet actions()}
		<Button href={resolve('/(dashboard)/settings/shares')} variant="outline" size="sm">
			<NetworkIcon />Network shares{data.shares ? ` (${data.shares})` : ''}
		</Button>
	{/snippet}
	{#if overview.nodes.length === 0}
		<p class="text-sm text-muted-foreground">
			No nodes yet. Enrol one under Nodes and its disks appear here.
		</p>
	{/if}
	<div class="space-y-6">
		{#each overview.nodes as node (node.id)}
			{@const usable = node.candidates.filter((item) => item.usable)}
			{@const unusable = node.candidates.filter((item) => !item.usable)}
			<section class="space-y-2">
				<div class="flex flex-wrap items-center gap-2">
					<ServerIcon class="size-4 text-muted-foreground" />
					<h3 class="text-sm font-semibold">{node.name}</h3>
					{#if node.status !== 'online'}<Badge variant="outline">{node.status}</Badge>{/if}
				</div>

				<!-- The system disk is always there. -->
				<div
					class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm"
				>
					<HardDriveIcon class="size-3.5 text-muted-foreground" />
					<span class="font-medium">System disk</span>
					<Badge variant="outline">built in</Badge>
					<span class="ml-auto text-xs text-muted-foreground">
						{node.system.freeBytes !== null
							? `${formatBytes(node.system.freeBytes)} free`
							: 'capacity not reported yet'}{node.system.sizeBytes
							? ` of ${formatBytes(node.system.sizeBytes)}`
							: ''}
					</span>
				</div>

				{#each node.disks as disk (disk.id)}
					<div class="space-y-2 rounded-md border px-3 py-2.5 text-sm">
						<div class="flex flex-wrap items-center gap-2">
							<HardDriveIcon class="size-3.5 text-muted-foreground" />
							<span class="font-medium">{disk.name}</span>
							<Badge variant={tierTone[disk.tier]}>{disk.tier}</Badge>
							{#if disk.remote}<Badge variant="outline">network</Badge>{/if}
							{#if statusLabel[disk.status]}<Badge variant={statusLabel[disk.status]!.tone}
									>{statusLabel[disk.status]!.label}</Badge
								>{/if}
							<span class="font-mono text-xs text-muted-foreground">{disk.mountPath}</span>
							<div class="ml-auto flex gap-1">
								<Button
									variant="ghost"
									size="xs"
									disabled={disk.status !== 'ready' ||
										disk.profile?.status === 'queued' ||
										disk.profile?.status === 'running'}
									onclick={() => profile(disk)}
								>
									<GaugeIcon class="size-3.5" />{disk.profile?.status === 'queued' ||
									disk.profile?.status === 'running'
										? 'Benchmarking…'
										: 'Benchmark'}
								</Button>
								<Button
									variant="ghost"
									size="xs"
									onclick={() => openEdit(disk)}
									disabled={disk.status === 'removing'}
								>
									<PencilIcon class="size-3.5" />Edit
								</Button>
								<Button
									variant="ghost"
									size="xs"
									aria-label="Remove {disk.name}"
									title={disk.share
										? 'Unmount it under Settings → Network shares'
										: disk.holds.length
											? `Holds ${disk.holds.join(', ')}`
											: 'Stop using this disk'}
									disabled={disk.status === 'removing' ||
										disk.share !== null ||
										disk.holds.length > 0}
									onclick={() => remove(disk)}
								>
									<Trash2Icon class="size-3.5" />
								</Button>
							</div>
						</div>
						{#if disk.sizeBytes}
							<div class="flex items-center gap-2">
								<div
									class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
									title="{usedPercent(disk)}% used"
								>
									<div class="h-full bg-brand" style="width: {usedPercent(disk)}%"></div>
								</div>
								<span class="shrink-0 text-xs text-muted-foreground">
									{formatBytes(disk.freeBytes)} free of {formatBytes(disk.sizeBytes)}
								</span>
							</div>
						{/if}
						{#if disk.message}<p class="text-xs text-destructive">{disk.message}</p>{/if}
						<p class="text-xs text-muted-foreground">
							{disk.holds.length ? `Holds ${disk.holds.join(', ')}.` : 'Nothing stored on it yet.'}
							{#if disk.share}From the network share “{disk.share}”.{/if}
							{#if !disk.tierSet}Tier detected from the hardware.{/if}
						</p>
						{#if disk.profile}<VolumeProfileStats profile={disk.profile} />{/if}
					</div>
				{/each}

				{#if !node.inventoryReported}
					<p class="text-xs text-muted-foreground">
						Waiting for {node.name} to report its disks (about a minute after the agent starts).
					</p>
				{:else if usable.length > 0}
					<div class="space-y-1.5 pt-1">
						<div class="text-xs font-medium text-muted-foreground">Add a disk</div>
						{#each usable as candidate (candidate.key)}
							<div
								class="flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm"
							>
								<PlusIcon class="size-3.5 text-muted-foreground" />
								<span class="font-mono text-xs">{candidate.device}</span>
								{#if candidate.label || candidate.model}
									<span class="text-xs text-muted-foreground"
										>{[candidate.label, candidate.model].filter(Boolean).join(' · ')}</span
									>
								{/if}
								<span class="text-xs text-muted-foreground">
									{formatBytes(candidate.sizeBytes)}{candidate.fsType
										? ` · ${candidate.fsType}`
										: ''} ·
									{candidate.needsMount ? 'not mounted' : `mounted at ${candidate.mountPath}`}
								</span>
								<Badge variant={tierTone[candidate.suggestedTier]}>{candidate.suggestedTier}</Badge>
								<Button
									variant="outline"
									size="xs"
									class="ml-auto"
									onclick={() => openAdd(node, candidate)}>Use this disk</Button
								>
							</div>
						{/each}
					</div>
				{:else if node.disks.length === 0}
					<p class="text-xs text-muted-foreground">
						No other disks to add. Mount one on the node, or attach a disk with a filesystem, and it
						appears here.
					</p>
				{/if}

				{#if unusable.length > 0}
					<details class="group text-xs">
						<summary
							class="inline-flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground"
						>
							<ChevronRightIcon class="size-3 transition-transform group-open:rotate-90" />
							Not usable ({unusable.length})
						</summary>
						<ul class="mt-1.5 space-y-1 pl-4">
							{#each unusable as candidate (candidate.key)}
								<li>
									<span class="font-mono">{candidate.device}</span>
									<span class="text-muted-foreground">
										{formatBytes(candidate.sizeBytes)}{candidate.fsType
											? ` · ${candidate.fsType}`
											: ''} — {candidate.reason}
									</span>
								</li>
							{/each}
						</ul>
					</details>
				{/if}
			</section>
		{/each}
	</div>
</Panel>

<!-- Dialogs ----------------------------------------------------------------------------- -->
{#if adding}
	<FormDialog
		bind:open={addOpen}
		icon={HardDriveIcon}
		title="Use {adding.candidate.device}"
		description={adding.candidate.needsMount
			? `${adding.node.name} mounts this ${adding.candidate.fsType} filesystem by its UUID at ${DISK_MOUNT_ROOT}/<name> and keeps it mounted across reboots. Nothing is formatted.`
			: `Yoal stores data under ${adding.candidate.mountPath}/yoal. Nothing outside that directory is touched.`}
		action="?/addDisk"
		submitLabel="Use this disk"
	>
		<input type="hidden" name="nodeId" value={adding.node.id} />
		<input type="hidden" name="candidate" value={adding.candidate.key} />
		<div class="grid gap-4 sm:grid-cols-2">
			<Field.Field>
				<Field.Label for="disk-name">Name</Field.Label>
				<Input
					id="disk-name"
					name="name"
					required
					minlength={3}
					maxlength={40}
					value={adding.candidate.suggestedName}
					class="font-mono text-sm"
				/>
			</Field.Field>
			<Field.Field>
				<Field.Label for="disk-tier">Tier</Field.Label>
				<NativeSelect.Root
					id="disk-tier"
					name="tier"
					class="w-full"
					value={adding.candidate.suggestedTier}
				>
					<NativeSelect.Option value="fast">Fast (SSD, NVMe)</NativeSelect.Option>
					<NativeSelect.Option value="bulk">Bulk (spinning disk, array, NAS)</NativeSelect.Option>
				</NativeSelect.Root>
				<Field.Description>Detected: {adding.candidate.suggestedTier}.</Field.Description>
			</Field.Field>
		</div>
	</FormDialog>
{/if}

{#if editing}
	<FormDialog
		bind:open={editOpen}
		icon={HardDriveIcon}
		title="Edit {editing.name}"
		action="?/updateDisk"
		submitLabel="Save"
	>
		<input type="hidden" name="id" value={editing.id} />
		<div class="grid gap-4 sm:grid-cols-2">
			<Field.Field>
				<Field.Label for="edit-name">Name</Field.Label>
				<Input
					id="edit-name"
					name="name"
					required
					minlength={3}
					maxlength={40}
					value={editing.name}
					class="font-mono text-sm"
				/>
			</Field.Field>
			<Field.Field>
				<Field.Label for="edit-tier">Tier</Field.Label>
				<NativeSelect.Root id="edit-tier" name="tier" class="w-full" value={editing.tier}>
					<NativeSelect.Option value="fast">Fast (SSD, NVMe)</NativeSelect.Option>
					<NativeSelect.Option value="bulk">Bulk (spinning disk, array, NAS)</NativeSelect.Option>
				</NativeSelect.Root>
				<Field.Description>Applies to new services; nothing already stored moves.</Field.Description
				>
			</Field.Field>
		</div>
	</FormDialog>
{/if}

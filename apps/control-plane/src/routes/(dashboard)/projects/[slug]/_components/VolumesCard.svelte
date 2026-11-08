<script lang="ts">
	import { page } from '$app/state';
	import type { StorageChoices } from '@skiff/contracts';
	import CameraIcon from '@lucide/svelte/icons/camera';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import UnplugIcon from '@lucide/svelte/icons/unplug';
	import {
		APP_VOLUME_USAGE_WARN_PERCENT,
		type AppVolumeSnapshotView,
		type AppVolumeView
	} from '@skiff/contracts';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import Panel from '../../../_lib/Panel.svelte';
	import RowMenu from '../../../_lib/RowMenu.svelte';
	import { formatBytes, formatDate } from '../../../_lib/format.js';

	/** Project-owned persistent application volumes (plan 07). */
	let {
		slug,
		volumes,
		workloadId,
		enabled,
		fieldErrors = {},
		can,
		storage = null
	}: {
		slug: string;
		volumes: AppVolumeView[];
		/** Storage targets on offer (docs/STORAGE.md §2.2). */
		storage?: StorageChoices | null;
		/** Workload id or the project slug; the server resolves either. */
		workloadId: string;
		enabled: boolean;
		fieldErrors?: Record<string, string>;
		can: { manageVolumes: boolean };
	} = $props();

	/** Settings → Retention & defaults trash period; the layout loads it. */
	const trashDays = $derived<number>(page.data.policies?.trashDays ?? 7);

	let createOpen = $state(false);
	let attachOpen = $state(false);
	let attaching = $state<AppVolumeView | null>(null);
	let mountPath = $state('/var/lib/app');
	let readOnly = $state(false);
	let sizeMb = $state(1024);
	/** `system`, `fast` or `bulk` (preselected to the default), or `__disk` to name one disk. */
	let storageChoice = $state('');
	$effect(() => {
		if (createOpen) storageChoice = storage?.defaultTarget ?? 'system';
	});
	let diskName = $state('');
	let singleWriter = $state(true);
	let snapshotOpen = $state(false);
	let snapshotting = $state<AppVolumeView | null>(null);
	let snapshotLive = $state(false);
	let restoreOpen = $state(false);
	let restoring = $state<{ volume: AppVolumeView; snapshot: AppVolumeSnapshotView } | null>(null);
	let restoreName = $state('');

	/** Snapshots shown per volume; the CLI and API list them all. */
	const SNAPSHOTS_SHOWN = 5;

	function openSnapshot(volume: AppVolumeView) {
		snapshotting = volume;
		snapshotLive = false;
		snapshotOpen = true;
	}

	function openRestore(volume: AppVolumeView, snapshot: AppVolumeSnapshotView) {
		restoring = { volume, snapshot };
		restoreName = `${volume.name}-restored`.slice(0, 40);
		restoreOpen = true;
	}

	function removeSnapshot(volume: AppVolumeView, snapshot: AppVolumeSnapshotView) {
		askConfirm({
			title: `Delete snapshot ${snapshot.label ?? snapshot.id}?`,
			description: `The archive is deleted from ${snapshot.target?.name ?? 'the platform object store'}. This cannot be undone.`,
			confirmLabel: 'Delete snapshot',
			tone: 'danger',
			action: '?/deleteVolumeSnapshot',
			fields: { volume: volume.name, snapshotId: snapshot.id }
		});
	}

	function snapshotSummary(snapshot: AppVolumeSnapshotView): string {
		const parts = [formatDate(snapshot.createdAt)];
		if (snapshot.sizeBytes !== null) parts.push(formatBytes(snapshot.sizeBytes));
		if (snapshot.method) parts.push(methodLabel[snapshot.method]);
		parts.push(snapshot.target?.name ?? 'platform store');
		return parts.join(' · ');
	}

	const methodLabel: Record<NonNullable<AppVolumeSnapshotView['method']>, string> = {
		reflink: 'paused briefly (reflink)',
		paused: 'paused while copying',
		idle: 'not in use',
		live: 'live copy'
	};

	function openAttach(volume: AppVolumeView) {
		attaching = volume;
		mountPath = volume.mountPath || '/var/lib/app';
		readOnly = false;
		attachOpen = true;
	}

	function detach(volume: AppVolumeView, environment: string) {
		askConfirm({
			title: `Unmount ${volume.name}?`,
			description: `${slug} restarts without ${volume.mountPath}. The volume and its data are untouched.`,
			confirmLabel: 'Unmount',
			tone: 'danger',
			action: '?/detachVolume',
			fields: { volume: volume.name, workload: workloadId, environment }
		});
	}

	function remove(volume: AppVolumeView) {
		askConfirm({
			title: `Delete ${volume.name}?`,
			description: `Its data is kept for ${trashDays} days after deletion, but it cannot be restored from the dashboard.`,
			confirmLabel: 'Delete volume',
			tone: 'danger',
			action: '?/deleteVolume',
			fields: { volume: volume.name }
		});
	}

	/** Usage against the volume's quota; null until the agent reports a sample. */
	function meter(volume: AppVolumeView) {
		const budget = volume.sizeMb * 1024 * 1024;
		if (volume.usedBytes === null)
			return { used: null, budget: formatBytes(budget), percent: null };
		const percent = budget > 0 ? Math.min(100, Math.round((volume.usedBytes / budget) * 100)) : 0;
		return { used: formatBytes(volume.usedBytes), budget: formatBytes(budget), percent };
	}
</script>

{#if enabled}
	<Panel
		title="Volumes"
		icon={HardDriveIcon}
		count={volumes.length}
		description="Directories that survive redeploys and restarts, mounted into the app at a path you choose."
		flush
	>
		{#snippet actions()}
			{#if can.manageVolumes}
				<Button size="sm" variant="outline" onclick={() => (createOpen = true)}>
					<PlusIcon />New volume
				</Button>
			{/if}
		{/snippet}

		{#if volumes.length === 0}
			<div class="p-4">
				<EmptyState
					icon={HardDriveIcon}
					compact
					title="No volumes yet"
					description="Create a volume, then mount it at a path such as /var/lib/app. It survives redeploys and restarts."
				>
					{#if can.manageVolumes}
						<Button size="sm" onclick={() => (createOpen = true)}><PlusIcon />New volume</Button>
					{/if}
				</EmptyState>
			</div>
		{:else}
			<ul class="divide-y">
				{#each volumes as volume (volume.id)}
					{@const usage = meter(volume)}
					<li class="flex items-start gap-3 px-4 py-3">
						<span
							class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
							aria-hidden="true"
						>
							<HardDriveIcon class="size-4" />
						</span>
						<div class="min-w-0 flex-1 space-y-2">
							<div>
								<p class="flex flex-wrap items-center gap-2">
									<span class="font-mono text-sm font-medium">{volume.name}</span>
									{#if volume.restoringFrom}
										<StatusBadge status="pending" label="restoring" />
									{:else}
										<StatusBadge status={volume.status} />
									{/if}
								</p>
								<p class="text-xs text-muted-foreground">
									{volume.backing === 'node_volume'
										? `On disk ${volume.disk?.name ?? '(removed)'}${volume.disk ? ` (${volume.disk.tier})` : ''}`
										: 'On the system disk'}{volume.singleWriter
										? ' · single writer'
										: ''} · created {formatDate(volume.createdAt)}
								</p>
								{#if volume.message}
									<p class="mt-1 text-xs text-muted-foreground">{volume.message}</p>
								{/if}
							</div>

							<div class="max-w-sm space-y-1">
								<div class="flex justify-between text-xs tabular-nums">
									<span class="text-muted-foreground">
										{usage.used === null ? 'Not measured yet' : `${usage.used} used`}
									</span>
									<span>{usage.budget}</span>
								</div>
								<Progress
									value={usage.percent ?? 0}
									class="h-1 {usage.percent !== null && usage.percent >= APP_VOLUME_USAGE_WARN_PERCENT
										? '[&_[data-slot=progress-indicator]]:bg-destructive'
										: usage.percent !== null && usage.percent >= 70
											? '[&_[data-slot=progress-indicator]]:bg-warning'
											: ''}"
									aria-label="{volume.name}: {usage.percent ?? 0}% of its quota"
								/>
								{#if volume.nearQuota}
									<p class="flex items-center gap-1 text-xs text-destructive">
										<TriangleAlertIcon class="size-3" aria-hidden="true" />
										Nearly full. Delete data or grow the volume.
									</p>
								{/if}
							</div>

							{#if volume.attachments.length === 0}
								<p class="text-xs text-muted-foreground">Not mounted</p>
							{:else}
								<ul class="space-y-1">
									{#each volume.attachments as attachment (attachment.id)}
										<li class="flex flex-wrap items-center gap-x-2 text-xs">
											<PlugIcon class="size-3 text-muted-foreground" aria-hidden="true" />
											<span class="font-mono">{attachment.mountPath}</span>
											<Badge variant="outline" class="font-normal">
												{attachment.readOnly ? 'read-only' : 'read-write'}
											</Badge>
											<span class="text-muted-foreground">{attachment.environment}</span>
										</li>
									{/each}
								</ul>
							{/if}

							{#if volume.snapshots.length > 0}
								<div class="space-y-1">
									<p class="text-xs font-medium">Snapshots</p>
									<ul class="space-y-1">
										{#each volume.snapshots.slice(0, SNAPSHOTS_SHOWN) as snapshot (snapshot.id)}
											<li class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
												<CameraIcon class="size-3 text-muted-foreground" aria-hidden="true" />
												<span class="font-medium">{snapshot.label ?? snapshot.id}</span>
												<StatusBadge status={snapshot.status} />
												<span class="text-muted-foreground">{snapshotSummary(snapshot)}</span>
												{#if snapshot.restoreVerifiedAt}
													<Badge variant="outline" class="font-normal">restore verified</Badge>
												{/if}
												{#if snapshot.error}
													<span class="w-full text-destructive">{snapshot.error}</span>
												{/if}
												{#if can.manageVolumes && (snapshot.status === 'ok' || snapshot.status === 'failed')}
													<span class="ml-auto flex gap-1">
														{#if snapshot.status === 'ok'}
															<Button
																size="sm"
																variant="ghost"
																class="h-6 px-2 text-xs"
																onclick={() => openRestore(volume, snapshot)}
															>
																<RotateCcwIcon />Restore…
															</Button>
														{/if}
														<Button
															size="sm"
															variant="ghost"
															class="h-6 px-2 text-xs"
															aria-label="Delete snapshot {snapshot.label ?? snapshot.id}"
															onclick={() => removeSnapshot(volume, snapshot)}
														>
															<TrashIcon />
														</Button>
													</span>
												{/if}
											</li>
										{/each}
									</ul>
									{#if volume.snapshots.length > SNAPSHOTS_SHOWN}
										<p class="text-xs text-muted-foreground">
											{volume.snapshots.length - SNAPSHOTS_SHOWN} older — list them with
											<code>skif volume snapshots {volume.name} --project {slug}</code>.
										</p>
									{/if}
								</div>
							{/if}
						</div>
						{#if can.manageVolumes}
							<RowMenu label="Actions for {volume.name}">
								<DropdownMenu.Item
									disabled={volume.attachments.length > 0 ||
										volume.restoringFrom !== null ||
										volume.status === 'failed'}
									onSelect={() => openAttach(volume)}
								>
									<PlugIcon />Mount in {slug}…
								</DropdownMenu.Item>
								{#each volume.attachments as attachment (attachment.id)}
									<DropdownMenu.Item onSelect={() => detach(volume, attachment.environment)}>
										<UnplugIcon />Unmount from {attachment.environment}
									</DropdownMenu.Item>
								{/each}
								<DropdownMenu.Item
									disabled={volume.restoringFrom !== null ||
										volume.snapshots.some((item) => item.status === 'pending' || item.status === 'running')}
									onSelect={() => openSnapshot(volume)}
								>
									<CameraIcon />Snapshot now…
								</DropdownMenu.Item>
								<DropdownMenu.Separator />
								<DropdownMenu.Item
									variant="destructive"
									disabled={volume.attachments.length > 0 || volume.restoringFrom !== null}
									onSelect={() => remove(volume)}
								>
									<TrashIcon />Delete volume
								</DropdownMenu.Item>
							</RowMenu>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</Panel>

	{#if can.manageVolumes}
		<FormDialog
			bind:open={createOpen}
			icon={HardDriveIcon}
			title="Create a volume"
			description="A quota and a backing. The node derives the host directory; only the volume id and mount path cross the API."
			action="?/createVolume"
			submitLabel="Create volume"
		>
			<Field.Group>
				<Field.Field data-invalid={fieldErrors.name ? true : undefined}>
					<Field.Label for="volume-name">Name</Field.Label>
					<Input
						id="volume-name"
						name="name"
						placeholder="app-data"
						required
						maxlength={40}
						autocapitalize="none"
						spellcheck="false"
						class="font-mono text-sm"
						aria-invalid={fieldErrors.name ? 'true' : undefined}
					/>
					<Field.Description>Lowercase letters, digits and single hyphens.</Field.Description>
					{#if fieldErrors.name}<Field.Error>{fieldErrors.name}</Field.Error>{/if}
				</Field.Field>
				<div class="grid gap-4 sm:grid-cols-2">
					<Field.Field data-invalid={fieldErrors.sizeMb ? true : undefined}>
						<Field.Label for="volume-size">Quota (MB)</Field.Label>
						<Input
							id="volume-size"
							name="sizeMb"
							type="number"
							min={1}
							max={1048576}
							bind:value={sizeMb}
							required
							aria-invalid={fieldErrors.sizeMb ? 'true' : undefined}
						/>
						{#if fieldErrors.sizeMb}<Field.Error>{fieldErrors.sizeMb}</Field.Error>{/if}
					</Field.Field>
					<Field.Field data-invalid={fieldErrors.storage ? true : undefined}>
						<Field.Label for="volume-storage">Storage</Field.Label>
						<NativeSelect.Root id="volume-storage" name="storage" bind:value={storageChoice} class="w-full">
							{#each storage?.targets ?? [{ value: 'system', label: 'System disk', available: true }] as target (target.value)}
								<NativeSelect.Option value={target.value} disabled={!target.available && target.value !== storageChoice}>
									{target.label}{target.value === storage?.defaultTarget ? ' (default)' : ''}{target.available ? '' : ' · none yet'}
								</NativeSelect.Option>
							{/each}
							<NativeSelect.Option value="__disk">A specific disk…</NativeSelect.Option>
						</NativeSelect.Root>
						{#if fieldErrors.storage}<Field.Error>{fieldErrors.storage}</Field.Error>{/if}
					</Field.Field>
				</div>
				{#if storageChoice === '__disk'}
					<Field.Field>
						<Field.Label for="volume-disk">Disk name</Field.Label>
						<Input id="volume-disk" name="disk" bind:value={diskName} placeholder="nvme" required class="font-mono text-sm" />
						<Field.Description>
							A disk on the project's node, as Settings → Storage names it. Ask a platform admin if you do not know it.
						</Field.Description>
					</Field.Field>
				{/if}
				<Field.Field orientation="horizontal">
					<Checkbox
						id="volume-single-writer"
						name="singleWriter"
						value="1"
						bind:checked={singleWriter}
					/>
					<Field.Label for="volume-single-writer">Single writer</Field.Label>
					<Field.Description
						>Refuse a second read-write attachment. Read-only mounts are allowed.</Field.Description
					>
				</Field.Field>
			</Field.Group>
		</FormDialog>

		<FormDialog
			bind:open={attachOpen}
			icon={PlugIcon}
			title="Mount {attaching?.name ?? ''}"
			description="The app restarts with the volume mounted at this absolute path inside its sandbox."
			action="?/attachVolume"
			submitLabel="Mount"
		>
			<input type="hidden" name="volume" value={attaching?.name ?? ''} />
			<input type="hidden" name="workload" value={workloadId} />
			<input type="hidden" name="environment" value="production" />
			<Field.Group>
				<Field.Field data-invalid={fieldErrors.mountPath ? true : undefined}>
					<Field.Label for="volume-mount">Mount path</Field.Label>
					<Input
						id="volume-mount"
						name="mountPath"
						bind:value={mountPath}
						required
						placeholder="/var/lib/app"
						class="font-mono text-sm"
						aria-invalid={fieldErrors.mountPath ? 'true' : undefined}
					/>
					<Field.Description>
						Absolute and normalized. System trees, /data and /var/lib/skiff are reserved.
					</Field.Description>
					{#if fieldErrors.mountPath}<Field.Error>{fieldErrors.mountPath}</Field.Error>{/if}
				</Field.Field>
				<Field.Field orientation="horizontal">
					<Checkbox id="volume-read-only" name="readOnly" value="1" bind:checked={readOnly} />
					<Field.Label for="volume-read-only">Mount read-only</Field.Label>
				</Field.Field>
			</Field.Group>
		</FormDialog>

		<FormDialog
			bind:open={snapshotOpen}
			icon={CameraIcon}
			title="Snapshot {snapshotting?.name ?? ''}"
			description="The node pauses the app while it copies the volume (a moment on btrfs or XFS, the whole copy otherwise), then uploads it to your backup target."
			action="?/snapshotVolume"
			submitLabel="Take snapshot"
		>
			<input type="hidden" name="volume" value={snapshotting?.name ?? ''} />
			<Field.Group>
				<Field.Field data-invalid={fieldErrors.label ? true : undefined}>
					<Field.Label for="snapshot-label">Label (optional)</Field.Label>
					<Input
						id="snapshot-label"
						name="label"
						maxlength={120}
						placeholder="before the v2 migration"
						aria-invalid={fieldErrors.label ? 'true' : undefined}
					/>
					{#if fieldErrors.label}<Field.Error>{fieldErrors.label}</Field.Error>{/if}
				</Field.Field>
				<Field.Field orientation="horizontal">
					<Checkbox id="snapshot-live" name="live" value="1" bind:checked={snapshotLive} />
					<Field.Label for="snapshot-live">Copy without pausing the app</Field.Label>
					<Field.Description>
						The copy may be inconsistent if the app writes while it runs.
					</Field.Description>
				</Field.Field>
			</Field.Group>
		</FormDialog>

		<FormDialog
			bind:open={restoreOpen}
			icon={RotateCcwIcon}
			title="Restore {restoring?.snapshot.label ?? restoring?.snapshot.id ?? ''}"
			description="Restoring creates a new volume in {slug}; {restoring?.volume.name ?? 'the source'} is not touched. Mount the new volume once the restore finishes."
			action="?/restoreVolumeSnapshot"
			submitLabel="Restore into new volume"
		>
			<input type="hidden" name="volume" value={restoring?.volume.name ?? ''} />
			<input type="hidden" name="snapshotId" value={restoring?.snapshot.id ?? ''} />
			<Field.Group>
				<Field.Field data-invalid={fieldErrors.name ? true : undefined}>
					<Field.Label for="restore-name">New volume name</Field.Label>
					<Input
						id="restore-name"
						name="name"
						bind:value={restoreName}
						required
						maxlength={40}
						autocapitalize="none"
						spellcheck="false"
						class="font-mono text-sm"
						aria-invalid={fieldErrors.name ? 'true' : undefined}
					/>
					{#if fieldErrors.name}<Field.Error>{fieldErrors.name}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={fieldErrors.sizeMb ? true : undefined}>
					<Field.Label for="restore-size">Quota (MB)</Field.Label>
					<Input
						id="restore-size"
						name="sizeMb"
						type="number"
						min={restoring?.volume.sizeMb ?? 1}
						max={1048576}
						placeholder={String(restoring?.volume.sizeMb ?? '')}
						aria-invalid={fieldErrors.sizeMb ? 'true' : undefined}
					/>
					<Field.Description>Defaults to the source's quota; it cannot be smaller.</Field.Description>
					{#if fieldErrors.sizeMb}<Field.Error>{fieldErrors.sizeMb}</Field.Error>{/if}
				</Field.Field>
			</Field.Group>
		</FormDialog>
	{/if}
{/if}

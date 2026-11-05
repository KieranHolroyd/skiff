<script lang="ts">
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import UnplugIcon from '@lucide/svelte/icons/unplug';
	import type { AppVolumeView } from '@skiff/contracts';
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
		can
	}: {
		slug: string;
		volumes: AppVolumeView[];
		/** Workload id or the project slug; the server resolves either. */
		workloadId: string;
		enabled: boolean;
		fieldErrors?: Record<string, string>;
		can: { manageVolumes: boolean };
	} = $props();

	let createOpen = $state(false);
	let attachOpen = $state(false);
	let attaching = $state<AppVolumeView | null>(null);
	let mountPath = $state('/var/lib/app');
	let readOnly = $state(false);
	let sizeMb = $state(1024);
	let backing = $state<'state_dir' | 'node_volume'>('state_dir');
	let nodeVolume = $state('');
	let singleWriter = $state(true);

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
			description:
				'Its data is kept for 7 days after deletion, but it cannot be restored from the dashboard.',
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
									<StatusBadge status={volume.status} />
								</p>
								<p class="text-xs text-muted-foreground">
									{volume.backing === 'node_volume'
										? `On node volume ${volume.nodeVolume?.name ?? '(removed)'}`
										: "On the node's state directory"}{volume.singleWriter
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
									class="h-1 {usage.percent !== null && usage.percent >= 85
										? '[&_[data-slot=progress-indicator]]:bg-destructive'
										: usage.percent !== null && usage.percent >= 70
											? '[&_[data-slot=progress-indicator]]:bg-warning'
											: ''}"
									aria-label="{volume.name}: {usage.percent ?? 0}% of its quota"
								/>
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
						</div>
						{#if can.manageVolumes}
							<RowMenu label="Actions for {volume.name}">
								<DropdownMenu.Item
									disabled={volume.attachments.length > 0}
									onSelect={() => openAttach(volume)}
								>
									<PlugIcon />Mount in {slug}…
								</DropdownMenu.Item>
								{#each volume.attachments as attachment (attachment.id)}
									<DropdownMenu.Item onSelect={() => detach(volume, attachment.environment)}>
										<UnplugIcon />Unmount from {attachment.environment}
									</DropdownMenu.Item>
								{/each}
								<DropdownMenu.Separator />
								<DropdownMenu.Item
									variant="destructive"
									disabled={volume.attachments.length > 0}
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
					<Field.Field data-invalid={fieldErrors.backing ? true : undefined}>
						<Field.Label for="volume-backing">Backing</Field.Label>
						<NativeSelect.Root
							id="volume-backing"
							name="backing"
							bind:value={backing}
							class="w-full"
						>
							<NativeSelect.Option value="state_dir">Helper state directory</NativeSelect.Option>
							<NativeSelect.Option value="node_volume">Registered node volume</NativeSelect.Option>
						</NativeSelect.Root>
						{#if fieldErrors.backing}<Field.Error>{fieldErrors.backing}</Field.Error>{/if}
					</Field.Field>
				</div>
				{#if backing === 'node_volume'}
					<Field.Field data-invalid={fieldErrors.nodeVolume ? true : undefined}>
						<Field.Label for="volume-node-volume">Node volume name</Field.Label>
						<Input
							id="volume-node-volume"
							name="nodeVolume"
							bind:value={nodeVolume}
							placeholder="data"
							required
							class="font-mono text-sm"
							aria-invalid={fieldErrors.nodeVolume ? 'true' : undefined}
						/>
						<Field.Description>
							Must already be registered on the project's node. Ask a platform admin if you do not
							know the name.
						</Field.Description>
						{#if fieldErrors.nodeVolume}<Field.Error>{fieldErrors.nodeVolume}</Field.Error>{/if}
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
	{/if}
{/if}

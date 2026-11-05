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
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import Panel from '../../../_lib/Panel.svelte';
	import { formatBytes, formatDateTime } from '../../../_lib/format.js';

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
			title: `Detach ${volume.name}?`,
			description: `${slug} restarts without ${volume.mountPath}. The volume and its data are untouched.`,
			confirmLabel: 'Detach',
			tone: 'danger',
			action: '?/detachVolume',
			fields: { volume: volume.name, workload: workloadId, environment }
		});
	}

	function remove(volume: AppVolumeView) {
		askConfirm({
			title: `Delete ${volume.name}?`,
			description:
				'Detach it first; after deletion its data is kept for 7 days. This cannot be undone from the dashboard.',
			confirmLabel: 'Delete volume',
			tone: 'danger',
			action: '?/deleteVolume',
			fields: { volume: volume.name }
		});
	}

	const used = (volume: AppVolumeView) => {
		const budget = volume.sizeMb * 1024 * 1024;
		if (volume.usedBytes === null) return `— / ${formatBytes(budget)}`;
		const percent = budget > 0 ? Math.round((volume.usedBytes / budget) * 100) : 0;
		return `${formatBytes(volume.usedBytes)} / ${formatBytes(budget)} (${percent}%)`;
	};
</script>

{#if enabled}
	<Panel
		title="Volumes"
		icon={HardDriveIcon}
		count={volumes.length}
		description="Persistent directories mounted into the app at an absolute path inside the workload. Quotas and disk admission are enforced by the control plane; the node derives the backing path."
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
					description="Create a volume, then attach it at a path such as /var/lib/app. It survives redeploys and restarts."
				/>
			</div>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="pl-4">Volume</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head class="hidden md:table-cell">Backing</Table.Head>
						<Table.Head class="hidden lg:table-cell">Used / quota</Table.Head>
						<Table.Head>Mounts</Table.Head>
						<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each volumes as volume (volume.id)}
						<Table.Row>
							<Table.Cell class="pl-4 align-top">
								<span class="font-mono text-xs font-medium">{volume.name}</span>
								<p class="text-[11px] text-muted-foreground">{formatDateTime(volume.createdAt)}</p>
							</Table.Cell>
							<Table.Cell class="align-top">
								<StatusBadge status={volume.status} />
								{#if volume.message}
									<p class="mt-1 max-w-52 text-[11px] text-muted-foreground">{volume.message}</p>
								{/if}
							</Table.Cell>
							<Table.Cell class="hidden align-top md:table-cell">
								<span class="font-mono text-xs">
									{volume.backing === 'node_volume'
										? `node:${volume.nodeVolume?.name ?? 'removed'}`
										: 'state-dir'}
								</span>
								{#if volume.singleWriter}
									<p class="text-[11px] text-muted-foreground">single writer</p>
								{/if}
							</Table.Cell>
							<Table.Cell class="hidden align-top whitespace-normal lg:table-cell">
								<span class="text-xs tabular-nums">{used(volume)}</span>
							</Table.Cell>
							<Table.Cell class="align-top whitespace-normal">
								{#if volume.attachments.length === 0}
									<span class="text-xs text-muted-foreground">Not attached</span>
								{:else}
									<div class="space-y-1">
										{#each volume.attachments as attachment (attachment.id)}
											<div class="flex items-center gap-2">
												<span class="font-mono text-[11px]">{attachment.mountPath}</span>
												<span class="text-[11px] text-muted-foreground">
													{attachment.readOnly ? 'read-only' : 'read-write'}
												</span>
												{#if can.manageVolumes}
													<Button
														variant="ghost-danger"
														size="icon-sm"
														aria-label="Detach {volume.name} from {attachment.environment}"
														onclick={() => detach(volume, attachment.environment)}
													>
														<UnplugIcon />
													</Button>
												{/if}
											</div>
										{/each}
									</div>
								{/if}
							</Table.Cell>
							<Table.Cell class="pr-4 text-right align-top">
								{#if can.manageVolumes}
									<div class="flex justify-end gap-1">
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Attach {volume.name}"
											disabled={volume.attachments.length > 0}
											onclick={() => openAttach(volume)}
										>
											<PlugIcon />
										</Button>
										<Button
											variant="ghost-danger"
											size="icon-sm"
											aria-label="Delete {volume.name}"
											onclick={() => remove(volume)}
										>
											<TrashIcon />
										</Button>
									</div>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
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
						<NativeSelect.Root id="volume-backing" name="backing" bind:value={backing} class="w-full">
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
							Must already be registered on the project's node. Ask a platform admin if you do not know
							the name.
						</Field.Description>
						{#if fieldErrors.nodeVolume}<Field.Error>{fieldErrors.nodeVolume}</Field.Error>{/if}
					</Field.Field>
				{/if}
				<Field.Field orientation="horizontal">
					<Checkbox id="volume-single-writer" name="singleWriter" value="1" bind:checked={singleWriter} />
					<Field.Label for="volume-single-writer">Single writer</Field.Label>
					<Field.Description>Refuse a second read-write attachment. Read-only mounts are allowed.</Field.Description>
				</Field.Field>
			</Field.Group>
		</FormDialog>

		<FormDialog
			bind:open={attachOpen}
			icon={PlugIcon}
			title="Attach {attaching?.name ?? ''}"
			description="The app restarts with the volume mounted at this absolute path inside its sandbox."
			action="?/attachVolume"
			submitLabel="Attach"
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

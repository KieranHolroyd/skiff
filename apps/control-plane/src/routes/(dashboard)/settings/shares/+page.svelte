<script lang="ts">
	import type { ShareMountView, ShareView } from '@yoal/contracts';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LinkIcon from '@lucide/svelte/icons/link';
	import ServerIcon from '@lucide/svelte/icons/server';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import { runAction } from '#lib/actions.js';
	import { invalidateAll } from '$app/navigation';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import VolumeProfileStats from '#lib/components/yoal/VolumeProfileStats.svelte';
	import type { Tone } from '#lib/status.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Add share
	let addOpen = $state(false);
	let protocol = $state<'nfs' | 'smb'>('nfs');

	// Per-share dialogs
	let grantsOpen = $state(false);
	let credentialsOpen = $state(false);
	let mountOpen = $state(false);
	let linkOpen = $state(false);
	let active = $state<ShareView | null>(null);
	let activeMount = $state<ShareMountView | null>(null);
	let grantText = $state('');

	// Refresh while a linked mount is being profiled, so results appear without a reload.
	const profiling = $derived(
		data.shares.some((share) =>
			share.mounts.some((mount) => mount.disk?.profile?.status === 'queued' || mount.disk?.profile?.status === 'running')
		)
	);
	$effect(() => {
		if (!profiling) return;
		const timer = setInterval(() => void invalidateAll(), 4_000);
		return () => clearInterval(timer);
	});

	const mountTones: Record<ShareMountView['status'], Tone> = {
		pending: 'info',
		mounted: 'success',
		failed: 'danger',
		unmounting: 'warning',
	};

	function openGrants(share: ShareView) {
		active = share;
		grantText = share.grants.map((grant) => [grant.orgId, grant.mode, grant.pathPrefix].filter(Boolean).join(' ')).join('\n');
		grantsOpen = true;
	}

	function openCredentials(share: ShareView) {
		active = share;
		credentialsOpen = true;
	}

	function openMount(share: ShareView) {
		active = share;
		mountOpen = true;
	}

	function openLink(share: ShareView, mount: ShareMountView) {
		active = share;
		activeMount = mount;
		linkOpen = true;
	}

	/** Nodes this share is not mounted on yet. */
	function mountTargets(share: ShareView) {
		const taken = new Set(share.mounts.map((mount) => mount.nodeId));
		return data.nodes.filter((node) => !taken.has(node.id));
	}

	function unmount(share: ShareView, mount: ShareMountView) {
		askConfirm({
			title: `Unmount “${share.name}” from ${mount.nodeName ?? mount.nodeId}?`,
			description: mount.disk
				? `The disk “${mount.disk.name}” is removed first; that is refused while anything is stored on it. Files on the server are untouched.`
				: 'The node unmounts the share. Files on the server are untouched.',
			confirmLabel: 'Unmount',
			tone: 'danger',
			action: '?/unmount',
			fields: { name: share.name, node: mount.nodeId },
		});
	}

	function unlink(share: ShareView, mount: ShareMountView) {
		askConfirm({
			title: `Stop using “${share.name}” as a disk?`,
			description: `The disk “${mount.disk?.name}” is removed; refused while anything is stored on it. The share stays mounted.`,
			confirmLabel: 'Stop using as disk',
			tone: 'danger',
			action: '?/unlink',
			fields: { name: share.name, node: mount.nodeId },
		});
	}

	function remove(share: ShareView) {
		askConfirm({
			title: `Remove share “${share.name}”?`,
			description: 'The registry entry, its credentials and grants are removed. The server export is untouched.',
			confirmLabel: 'Remove share',
			tone: 'danger',
			action: '?/remove',
			fields: { name: share.name },
		});
	}
</script>

<SettingsHeader
	id="shares"
	description="Define an NFS export or SMB share once and mount it on the nodes that need it. A read-write share becomes a disk under Settings → Storage. Looking for a link that lets someone view a protected site? Share links live on each project's Share links tab."
>
	{#snippet actions()}
		<Button size="sm" onclick={() => (addOpen = true)}><PlusIcon />Add network share</Button>
	{/snippet}
</SettingsHeader>

{#if data.denied}
	<EmptyState
		icon={HardDriveIcon}
		title="Platform admin required"
		description="Network shares are platform infrastructure: they name servers, exports and org grants. Share links for a site are on each project's Share links tab."
	/>
{:else if data.shares.length === 0}
	<EmptyState
		icon={HardDriveIcon}
		title="No network shares yet"
		description="Add an NFS export or SMB share, mount it on a node, and Yoal can keep data on it."
	>
		<Button size="sm" onclick={() => (addOpen = true)}><PlusIcon />Add network share</Button>
	</EmptyState>
{:else}
	<div class="grid gap-4">
		{#each data.shares as share (share.id)}
			<Card.Root>
				<Card.Header class="flex flex-row flex-wrap items-start justify-between gap-3">
					<div class="min-w-0 space-y-1">
						<Card.Title class="flex flex-wrap items-center gap-2">
							{share.name}
							<Badge variant="outline" class="font-mono text-[10px] uppercase">{share.protocol}</Badge>
							<Badge variant="outline">{share.readOnly ? 'read-only' : 'read-write'}</Badge>
							{#if share.zone !== 'default'}<Badge variant="outline" class="font-mono text-[10px]">{share.zone}</Badge>{/if}
						</Card.Title>
						<Card.Description class="break-all font-mono text-xs">
							{share.protocol === 'smb' ? `//${share.server}${share.exportPath}` : `${share.server}:${share.exportPath}`}
							{#if share.protocol === 'smb'}
								<span class="font-sans">
									· {share.hasCredentials ? `as ${share.username ?? 'stored user'}` : 'no credentials'}
								</span>
							{/if}
						</Card.Description>
					</div>
					<div class="flex flex-wrap gap-1">
						<Button size="xs" onclick={() => openMount(share)} disabled={mountTargets(share).length === 0}>
							<ServerIcon class="size-3.5" />Mount on node
						</Button>
						{#if share.protocol === 'smb'}
							<Button variant="ghost" size="xs" onclick={() => openCredentials(share)}>
								<KeyRoundIcon class="size-3.5" />Credentials
							</Button>
						{/if}
						<Button variant="ghost" size="xs" onclick={() => openGrants(share)}>Grants</Button>
						<Button variant="ghost" size="xs" aria-label="Remove share" onclick={() => remove(share)}>
							<Trash2Icon class="size-3.5" />
						</Button>
					</div>
				</Card.Header>
				<Card.Content class="space-y-2">
					{#if share.mounts.length === 0}
						<p class="text-sm text-muted-foreground">Not mounted anywhere yet.</p>
					{:else}
						{#each share.mounts as mount (mount.id)}
							<div class="flex flex-wrap items-start justify-between gap-2 rounded-md border px-3 py-2 text-sm">
								<div class="min-w-0 space-y-1">
									<div class="flex flex-wrap items-center gap-2">
										<span class="font-medium">{mount.nodeName ?? mount.nodeId}</span>
										<StatusBadge status={mount.status} tone={mountTones[mount.status]} />
										{#if mount.disk}
											<Badge variant="info"><LinkIcon class="size-3" />Disk {mount.disk.name}</Badge>
										{:else if mount.diskName && mount.status !== 'unmounting'}
											<Badge variant="outline">Becomes disk {mount.diskName} once mounted</Badge>
										{/if}
									</div>
									<div class="font-mono text-xs text-muted-foreground">{mount.mountPath}</div>
									{#if mount.message}
										<div class="text-xs text-destructive">{mount.message}</div>
									{/if}
									{#if mount.disk?.profile}<VolumeProfileStats profile={mount.disk.profile} />{/if}
								</div>
								{#if mount.status !== 'unmounting'}
									<div class="flex flex-wrap gap-1">
										{#if mount.disk}
											<Button
												variant="outline"
												size="xs"
												disabled={mount.disk.profile?.status === 'queued' || mount.disk.profile?.status === 'running'}
												onclick={() => void runAction('?/profile', { diskId: mount.disk!.id, name: share.name })}
											>
												<GaugeIcon class="size-3.5" />Profile
											</Button>
											<Button variant="ghost" size="xs" onclick={() => unlink(share, mount)}>Stop using as disk</Button>
										{:else if !mount.diskName && !share.readOnly}
											<Button variant="outline" size="xs" onclick={() => openLink(share, mount)}>
												<LinkIcon class="size-3.5" />Use as disk
											</Button>
										{/if}
										<Button variant="ghost" size="xs" onclick={() => unmount(share, mount)}>Unmount</Button>
									</div>
								{/if}
							</div>
						{/each}
					{/if}
					{#if share.grants.length > 0}
						<p class="text-xs text-muted-foreground">
							Grants: {share.grants.map((grant) => `${grant.orgId} (${grant.mode})`).join(', ')}
						</p>
					{/if}
				</Card.Content>
			</Card.Root>
		{/each}
	</div>
{/if}

{#if !data.denied}
	<FormDialog
		bind:open={addOpen}
		icon={HardDriveIcon}
		title="Add a network share"
		description="Define the export once. Mount it on a node next; a read-write share then becomes a disk."
		action="?/create"
		submitLabel="Create share"
	>
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="share-name">Name</Field.Label>
					<Input id="share-name" name="name" required maxlength={40} placeholder="media" class="font-mono text-sm" />
					<Field.Description>Also the mount directory: /mnt/yoal-shares/&lt;name&gt;.</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="share-protocol">Protocol</Field.Label>
					<NativeSelect.Root id="share-protocol" name="protocol" class="w-full" bind:value={protocol}>
						<NativeSelect.Option value="nfs">NFS</NativeSelect.Option>
						<NativeSelect.Option value="smb">SMB / CIFS</NativeSelect.Option>
					</NativeSelect.Root>
				</Field.Field>
			</div>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="share-server">Server</Field.Label>
					<Input id="share-server" name="server" required placeholder={protocol === 'smb' ? 'nas.local' : '10.0.0.5'} class="font-mono text-sm" />
				</Field.Field>
				<Field.Field>
					<Field.Label for="share-export">{protocol === 'smb' ? 'Share' : 'Export path'}</Field.Label>
					<Input
						id="share-export"
						name="exportPath"
						required
						placeholder={protocol === 'smb' ? '/media' : '/mnt/user/media'}
						class="font-mono text-sm"
					/>
					<Field.Description>
						{protocol === 'smb' ? 'The share name with a leading slash; a subfolder may follow.' : 'The absolute path the server exports.'}
					</Field.Description>
				</Field.Field>
			</div>
			{#if protocol === 'smb'}
				<div class="grid gap-4 sm:grid-cols-3">
					<Field.Field>
						<Field.Label for="share-username">Username</Field.Label>
						<Input id="share-username" name="username" required autocomplete="off" />
					</Field.Field>
					<Field.Field>
						<Field.Label for="share-password">Password</Field.Label>
						<Input id="share-password" name="password" type="password" required autocomplete="new-password" />
					</Field.Field>
					<Field.Field>
						<Field.Label for="share-domain">Domain</Field.Label>
						<Input id="share-domain" name="domain" placeholder="optional" autocomplete="off" />
					</Field.Field>
				</div>
				<p class="text-xs text-muted-foreground">
					Sealed with the platform key. Nodes fetch them only to mount; they never appear in the dashboard, logs or audit.
				</p>
			{/if}
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="share-zone">Zone</Field.Label>
					<Input id="share-zone" name="zone" placeholder="home" maxlength={32} />
				</Field.Field>
				<Field.Field orientation="horizontal" class="gap-2 pt-6">
					<input type="checkbox" id="share-readonly" name="readOnly" value="1" class="size-4 accent-brand" />
					<Field.Label for="share-readonly" class="font-normal">Mount read-only</Field.Label>
				</Field.Field>
			</div>
			<p class="text-xs text-muted-foreground">
				Nodes need {protocol === 'smb' ? 'cifs-utils' : 'nfs-common (or nfs-utils)'} installed. Network disks trade
				latency and locking guarantees for capacity; Yoal does not back up what lives on a share.
			</p>
		</Field.Group>
	</FormDialog>

	{#if active}
		<FormDialog
			bind:open={mountOpen}
			icon={ServerIcon}
			title="Mount {active.name}"
			description="The node's helper mounts it at /mnt/yoal-shares/{active.name} and keeps it mounted across restarts."
			action="?/mount"
			submitLabel="Mount"
		>
			<input type="hidden" name="name" value={active.name} />
			<Field.Group>
				<Field.Field>
					<Field.Label for="mount-node">Node</Field.Label>
					<NativeSelect.Root id="mount-node" name="node" class="w-full" required>
						{#each mountTargets(active) as node (node.id)}
							<NativeSelect.Option value={node.id}>{node.name} ({node.status})</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
				{#if active.readOnly}
					<Field.Description>Read-only: it is mounted for reading and does not become a disk.</Field.Description>
				{:else}
					<Field.Field>
						<Field.Label for="mount-disk">Disk name</Field.Label>
						<Input id="mount-disk" name="diskName" value={active.name} maxlength={40} class="font-mono text-sm" />
						<Field.Description>Once mounted it is a bulk, network disk under Settings → Storage.</Field.Description>
					</Field.Field>
				{/if}
			</Field.Group>
		</FormDialog>

		{#if activeMount}
			<FormDialog
				bind:open={linkOpen}
				icon={LinkIcon}
				title="Use {active.name} as a disk"
				description="Makes the mount on {activeMount.nodeName ?? activeMount.nodeId} a disk under Settings → Storage, so services can be stored on it."
				action="?/link"
				submitLabel="Use as disk"
			>
				<input type="hidden" name="name" value={active.name} />
				<input type="hidden" name="node" value={activeMount.nodeId} />
				<Field.Field>
					<Field.Label for="link-disk">Disk name</Field.Label>
					<Input id="link-disk" name="diskName" value={active.name} maxlength={40} class="font-mono text-sm" />
				</Field.Field>
			</FormDialog>
		{/if}

		<FormDialog
			bind:open={credentialsOpen}
			icon={KeyRoundIcon}
			title="Credentials for {active.name}"
			description="Replaces the stored SMB username and password. Working mounts keep their session; failed mounts retry with these at once."
			action="?/credentials"
			submitLabel="Save credentials"
		>
			<input type="hidden" name="name" value={active.name} />
			<div class="grid gap-4 sm:grid-cols-3">
				<Field.Field>
					<Field.Label for="cred-username">Username</Field.Label>
					<Input id="cred-username" name="username" required value={active.username ?? ''} autocomplete="off" />
				</Field.Field>
				<Field.Field>
					<Field.Label for="cred-password">Password</Field.Label>
					<Input id="cred-password" name="password" type="password" required autocomplete="new-password" />
				</Field.Field>
				<Field.Field>
					<Field.Label for="cred-domain">Domain</Field.Label>
					<Input id="cred-domain" name="domain" placeholder="optional" autocomplete="off" />
				</Field.Field>
			</div>
		</FormDialog>

		<FormDialog
			bind:open={grantsOpen}
			icon={HardDriveIcon}
			title="Grants for {active.name}"
			description="One per line: org id, mode (ro or rw), optional path prefix."
			action="?/grants"
			submitLabel="Save grants"
		>
			<input type="hidden" name="name" value={active.name} />
			<Field.Field>
				<Field.Label for="share-grants">Grants</Field.Label>
				<Textarea id="share-grants" name="grants" bind:value={grantText} rows={6} class="font-mono text-xs" placeholder={'org_123 ro media/\norg_456 rw'} />
			</Field.Field>
		</FormDialog>
	{/if}
{/if}

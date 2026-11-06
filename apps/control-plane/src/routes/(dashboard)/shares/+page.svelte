<script lang="ts">
	import type { ShareView } from '@skiff/contracts';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Share2Icon from '@lucide/svelte/icons/share-2';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import { toast } from 'svelte-sonner';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let addOpen = $state(false);
	let grantsOpen = $state(false);
	let grantShare = $state<ShareView | null>(null);
	let grantText = $state('');

	const result = $derived(form as { success?: string; message?: string } | null);
	$effect(() => {
		if (result?.success) toast.success(result.success);
		else if (result?.message) toast.error(result.message);
	});

	function openGrants(share: ShareView) {
		grantShare = share;
		grantText = share.grants.map((grant) => [grant.orgId, grant.mode, grant.pathPrefix].filter(Boolean).join(' ')).join('\n');
		grantsOpen = true;
	}
</script>

<PageHeader
	title="Shares"
	description="Platform-level NFS and SMB filesystems, with the orgs allowed to mount them."
>
	<Button size="sm" onclick={() => (addOpen = true)}><PlusIcon />Add share</Button>
</PageHeader>

{#if data.denied}
	<EmptyState
		icon={Share2Icon}
		title="Platform admin required"
		description="Shares are platform infrastructure: they name servers, exports and org grants."
	/>
{:else if data.shares.length === 0}
	<EmptyState
		icon={Share2Icon}
		title="No shares yet"
		description="Register an NFS or SMB export once, then grant it to organisations."
	>
		<Button size="sm" onclick={() => (addOpen = true)}><PlusIcon />Add share</Button>
	</EmptyState>
{:else}
	<Card.Root>
		<Card.Content class="overflow-x-auto">
			<table class="w-full text-sm">
				<thead class="text-left text-xs uppercase tracking-wide text-muted-foreground">
					<tr class="border-b">
						<th class="px-2 py-2">Share</th>
						<th class="px-2 py-2">Server / export</th>
						<th class="px-2 py-2">Zone</th>
						<th class="px-2 py-2">Mode</th>
						<th class="px-2 py-2">Grants</th>
						<th class="px-2 py-2"></th>
					</tr>
				</thead>
				<tbody>
					{#each data.shares as share (share.id)}
						<tr class="border-b last:border-0 align-top">
							<td class="px-2 py-3">
								<div class="font-medium">{share.name}</div>
								<Badge variant="outline" class="font-mono text-[10px]">{share.protocol}</Badge>
							</td>
							<td class="px-2 py-3 font-mono text-xs">{share.server}:{share.exportPath}</td>
							<td class="px-2 py-3 font-mono text-xs">{share.zone}</td>
							<td class="px-2 py-3">{share.readOnly ? 'read-only' : 'read-write'}</td>
							<td class="px-2 py-3 text-xs">
								{#if share.grants.length === 0}
									<span class="text-muted-foreground">none</span>
								{:else}
									{share.grants.map((grant) => `${grant.orgId} (${grant.mode})`).join(', ')}
								{/if}
							</td>
							<td class="px-2 py-3 text-right">
								<Button variant="ghost" size="xs" onclick={() => openGrants(share)}>Grants</Button>
								<Button
									variant="ghost"
									size="xs"
									onclick={() =>
									askConfirm({
										title: `Remove share “${share.name}”?`,
										description: 'The registry entry and its grants are removed. The server export is untouched.',
										confirmLabel: 'Remove share',
										tone: 'danger',
										action: '?/remove',
										fields: { name: share.name },
									})}
								>
									<Trash2Icon class="size-3.5" />
								</Button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</Card.Content>
	</Card.Root>
{/if}

{#if !data.denied}
	<FormDialog
		bind:open={addOpen}
		icon={Share2Icon}
		title="Add a share"
		description="Register the export now; attaching it to app volumes comes next."
		action="?/create"
		submitLabel="Create share"
	>
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="share-name">Name</Field.Label>
					<Input id="share-name" name="name" required maxlength={40} placeholder="media" class="font-mono text-sm" />
				</Field.Field>
				<Field.Field>
					<Field.Label for="share-protocol">Protocol</Field.Label>
					<NativeSelect.Root id="share-protocol" name="protocol" class="w-full">
						<NativeSelect.Option value="nfs">NFS</NativeSelect.Option>
						<NativeSelect.Option value="smb">SMB</NativeSelect.Option>
					</NativeSelect.Root>
				</Field.Field>
			</div>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="share-server">Server</Field.Label>
					<Input id="share-server" name="server" required placeholder="10.0.0.5" class="font-mono text-sm" />
				</Field.Field>
				<Field.Field>
					<Field.Label for="share-export">Export path</Field.Label>
					<Input id="share-export" name="exportPath" required placeholder="/mnt/media" class="font-mono text-sm" />
				</Field.Field>
			</div>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="share-zone">Zone</Field.Label>
					<Input id="share-zone" name="zone" placeholder="home" maxlength={32} />
				</Field.Field>
				<Field.Field orientation="horizontal" class="gap-2 pt-6">
					<input type="checkbox" id="share-readonly" name="readOnly" value="1" checked class="size-4 accent-brand" />
					<Field.Label for="share-readonly" class="font-normal">Read-only by default</Field.Label>
				</Field.Field>
			</div>
		</Field.Group>
	</FormDialog>

	{#if grantShare}
		<FormDialog
			bind:open={grantsOpen}
			icon={Share2Icon}
			title="Grants for {grantShare.name}"
			description="One per line: org id, mode (ro or rw), optional path prefix."
			action="?/grants"
			submitLabel="Save grants"
		>
			<input type="hidden" name="name" value={grantShare.name} />
			<Field.Field>
				<Field.Label for="share-grants">Grants</Field.Label>
				<Textarea id="share-grants" name="grants" bind:value={grantText} rows={6} class="font-mono text-xs" placeholder={'org_123 ro media/\norg_456 rw'} />
			</Field.Field>
		</FormDialog>
	{/if}
{/if}

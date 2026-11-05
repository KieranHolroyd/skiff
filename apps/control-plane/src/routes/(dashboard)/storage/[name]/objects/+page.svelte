<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import FileIcon from '@lucide/svelte/icons/file';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderPlusIcon from '@lucide/svelte/icons/folder-plus';
	import LinkIcon from '@lucide/svelte/icons/link';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import { toast } from 'svelte-sonner';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import PageHeader from '../../../_lib/PageHeader.svelte';
	import { formatBytes, formatDateTime } from '../../../_lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let selected = $state<Set<string>>(new Set());
	const objectKeys = $derived(data.list?.objects.map((object) => object.key) ?? []);
	const allSelected = $derived(objectKeys.length > 0 && objectKeys.every((key) => selected.has(key)));

	// A new bucket/prefix is a new view; selections from the previous one must not leak into it.
	let lastView = '';
	$effect(() => {
		const view = `${data.bucket ?? ''}|${data.prefix}`;
		if (view !== lastView) {
			lastView = view;
			selected = new Set();
		}
	});

	function href(bucket: string, prefix = '', token?: string): string {
		const params = new URLSearchParams({ bucket });
		if (prefix) params.set('prefix', prefix);
		if (token) params.set('token', token);
		return `?${params.toString()}`;
	}

	function downloadHref(key: string): string {
		const params = new URLSearchParams({ bucket: data.bucket ?? '', key });
		return `/api/v1/storage/${encodeURIComponent(data.storage.name)}/objects/item?${params.toString()}`;
	}

	const crumbs = $derived(
		data.prefix
			.split('/')
			.filter(Boolean)
			.map((part, index, all) => ({
				name: part,
				prefix: `${all.slice(0, index + 1).join('/')}/`
			}))
	);

	const visibleName = $derived((key: string) =>
		data.prefix && key.startsWith(data.prefix) ? key.slice(data.prefix.length) : key
	);

	function toggle(key: string) {
		const next = new Set(selected);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		selected = next;
	}

	function toggleAll() {
		selected = allSelected ? new Set() : new Set(objectKeys);
	}

	function deleteObject(key: string) {
		if (!data.bucket) return;
		askConfirm({
			title: `Delete “${key}”?`,
			description: 'The object is removed from the bucket. This cannot be undone.',
			confirmLabel: 'Delete object',
			tone: 'danger',
			action: '?/delete',
			fields: { bucket: data.bucket, key, prefix: data.prefix }
		});
	}

	function deleteSelected() {
		if (!data.bucket || selected.size === 0) return;
		askConfirm({
			title: `Delete ${selected.size} object${selected.size === 1 ? '' : 's'}?`,
			description: 'The selected objects are removed from the bucket. This cannot be undone.',
			confirmLabel: 'Delete selected',
			tone: 'danger',
			action: '?/deleteMany',
			fields: {
				bucket: data.bucket,
				keys: JSON.stringify([...selected]),
				prefix: data.prefix
			}
		});
	}

	let shareOpen = $state(false);
	let shareKey = $state('');
	let shareExpiry = $state('604800');
	let shareLimit = $state('');
	let shareBusy = $state(false);

	function openShare(key: string) {
		shareKey = key;
		shareExpiry = '604800';
		shareLimit = '';
		shareOpen = true;
	}

	async function createShare() {
		if (!data.bucket) return;
		const limit = shareLimit.trim() === '' ? undefined : Number(shareLimit);
		if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
			toast.error('The download limit must be a positive whole number.');
			return;
		}
		shareBusy = true;
		const response = await fetch(
			`/api/v1/storage/${encodeURIComponent(data.storage.name)}/buckets/${encodeURIComponent(data.bucket)}/sign`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					key: shareKey,
					method: 'GET',
					expiresIn: Number(shareExpiry),
					...(limit ? { maxDownloads: limit } : {})
				})
			}
		);
		const body = (await response.json().catch(() => ({}))) as {
			url?: string;
			message?: string;
			expiresAt?: string;
			direct?: boolean;
		};
		shareBusy = false;
		if (!response.ok || !body.url) {
			toast.error(body.message ?? 'Could not create a share link.');
			return;
		}
		await navigator.clipboard.writeText(body.url);
		shareOpen = false;
		toast.success(
			`Share link copied until ${new Date(body.expiresAt ?? Date.now()).toLocaleString()}` +
				`${limit ? ` (${limit} download${limit === 1 ? '' : 's'})` : ''}.`
		);
	}

	function removeFolder(prefix: string) {
		if (!data.bucket) return;
		askConfirm({
			title: `Delete the folder “${prefix}”?`,
			description:
				'The folder marker is deleted; objects inside it are not. Empty it first if you want the prefix gone.',
			confirmLabel: 'Delete folder marker',
			tone: 'danger',
			action: '?/delete',
			fields: { bucket: data.bucket, key: prefix, prefix: data.prefix }
		});
	}
</script>

<svelte:head>
	<title>{data.storage.name} objects · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader eyebrow="Storage" title="{data.storage.name} · Objects" target="page.storage">
		<Button
			variant="outline"
			href={resolve('/(dashboard)/storage/[name]', { name: data.storage.name })}
		>
			<ArrowLeftIcon />
			Instance
		</Button>
	</PageHeader>

	{#if data.buckets.length === 0}
		<EmptyState
			icon={ShieldAlertIcon}
			title="No ready buckets"
			description="Create a bucket on the instance page first; a bucket being deleted is not browsable."
		/>
	{:else}
		<div class="flex flex-wrap items-center gap-1.5">
			{#each data.buckets as item (item.name)}
				<Button
					size="sm"
					variant={item.name === data.bucket ? 'secondary' : 'ghost'}
					href={href(item.name)}
				>
					{item.name}
					{#if item.access === 'public-read'}<Badge variant="info">public</Badge>{/if}
				</Button>
			{/each}
		</div>

		{#if data.bucket}
			<div class="flex flex-wrap items-center gap-1 text-sm">
				<a class="text-muted-foreground hover:text-foreground" href={href(data.bucket)}>All objects</a>
				{#each crumbs as crumb (crumb.prefix)}
					<ChevronRightIcon class="size-3.5 text-muted-foreground" />
					<a class="text-muted-foreground hover:text-foreground" href={href(data.bucket, crumb.prefix)}>
						{crumb.name}
					</a>
				{/each}
			</div>

			{#if data.canWrite}
				<div class="grid gap-3 lg:grid-cols-2">
					<form
						method="POST"
						action="?/upload"
						enctype="multipart/form-data"
						class="flex flex-wrap items-end gap-2 rounded-lg border p-3"
					>
						<input type="hidden" name="bucket" value={data.bucket} />
						<input type="hidden" name="prefix" value={data.prefix} />
						<div class="min-w-40 flex-1 space-y-1">
							<label class="text-xs text-muted-foreground" for="object-key">Key (optional)</label>
							<Input
								id="object-key"
								name="key"
								placeholder={data.prefix ? `${data.prefix}file.txt` : 'folder/file.txt'}
							/>
						</div>
						<div class="space-y-1">
							<label class="text-xs text-muted-foreground" for="object-file">File</label>
							<input
								id="object-file"
								type="file"
								name="file"
								required
								class="block text-xs text-muted-foreground file:mr-2 file:rounded-md file:border file:bg-background file:px-2 file:py-1 file:text-xs"
							/>
						</div>
						<Button type="submit" size="sm"><UploadIcon />Upload</Button>
						<p class="w-full text-xs text-muted-foreground">
							Dashboard uploads are limited to {data.maxUploadMb} MB. Larger files need a presigned
							upload or the CLI.
						</p>
					</form>

					<form
						method="POST"
						action="?/folder"
						class="flex flex-wrap items-end gap-2 rounded-lg border p-3"
					>
						<input type="hidden" name="bucket" value={data.bucket} />
						<div class="min-w-40 flex-1 space-y-1">
							<label class="text-xs text-muted-foreground" for="folder-prefix">New folder</label>
							<Input id="folder-prefix" name="prefix" placeholder="photos/2026" required />
						</div>
						<Button type="submit" size="sm" variant="outline"><FolderPlusIcon />Create</Button>
					</form>
				</div>
			{/if}

			{#if data.listError}
				<Notice tone="warning" title="Could not list this bucket">{data.listError}</Notice>
			{:else if data.list}
				{#if selected.size > 0 && data.canWrite}
					<div class="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2">
						<span class="text-sm">{selected.size} selected</span>
						<Button size="sm" variant="destructive" onclick={deleteSelected}>
							<Trash2Icon />Delete selected
						</Button>
					</div>
				{/if}

				<div class="rounded-lg border">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head class="w-8">
									<input
										type="checkbox"
										aria-label="Select all objects"
										checked={allSelected}
										disabled={objectKeys.length === 0}
										onchange={toggleAll}
									/>
								</Table.Head>
								<Table.Head>Name</Table.Head>
								<Table.Head class="hidden text-right sm:table-cell">Size</Table.Head>
								<Table.Head class="hidden md:table-cell">Modified</Table.Head>
								<Table.Head class="w-28 text-right">Actions</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each data.list.prefixes as prefix (prefix)}
								<Table.Row>
									<Table.Cell></Table.Cell>
									<Table.Cell>
										<a
											class="inline-flex items-center gap-2 font-medium hover:underline"
											href={href(data.bucket, prefix)}
										>
											<FolderIcon class="size-4 text-muted-foreground" />
											{prefix.slice(data.prefix.length)}
										</a>
									</Table.Cell>
									<Table.Cell class="hidden text-right text-muted-foreground sm:table-cell">—</Table.Cell>
									<Table.Cell class="hidden text-muted-foreground md:table-cell">—</Table.Cell>
									<Table.Cell class="text-right">
										{#if data.canWrite}
											<Button
												size="sm"
												variant="ghost"
												title="Delete the folder marker"
												onclick={() => removeFolder(prefix)}
											>
												<Trash2Icon />
											</Button>
										{/if}
									</Table.Cell>
								</Table.Row>
							{/each}
							{#each data.list.objects as object (object.key)}
								<Table.Row>
									<Table.Cell>
										<input
											type="checkbox"
											aria-label="Select {object.key}"
											checked={selected.has(object.key)}
											onchange={() => toggle(object.key)}
										/>
									</Table.Cell>
									<Table.Cell>
										<span class="inline-flex items-center gap-2">
											<FileIcon class="size-4 text-muted-foreground" />
											<span class="font-mono text-xs">{visibleName(object.key)}</span>
										</span>
									</Table.Cell>
									<Table.Cell class="hidden text-right font-mono text-xs tabular-nums sm:table-cell">
										{formatBytes(object.sizeBytes)}
									</Table.Cell>
									<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
										{object.lastModified ? formatDateTime(object.lastModified) : '—'}
									</Table.Cell>
									<Table.Cell class="text-right">
										<Button
											size="sm"
											variant="ghost"
											href={downloadHref(object.key)}
											title="Download"
										>
											<DownloadIcon />
										</Button>
										<Button
											size="sm"
											variant="ghost"
											title="Create a signed share link"
											onclick={() => openShare(object.key)}
										>
											<LinkIcon />
										</Button>
										{#if data.canWrite}
											<Button
												size="sm"
												variant="ghost"
												title="Delete"
												onclick={() => deleteObject(object.key)}
											>
												<Trash2Icon />
											</Button>
										{/if}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>

					{#if data.list.objects.length === 0 && data.list.prefixes.length === 0}
						<div class="p-8">
							<EmptyState
								icon={FolderIcon}
								title="This folder is empty"
								description={data.canWrite
									? 'Upload a file or create a folder above.'
									: 'There are no objects under this prefix.'}
							/>
						</div>
					{/if}
				</div>

				{#if data.list.isTruncated && data.list.nextToken}
					<div class="flex justify-end">
						<Button variant="outline" size="sm" href={href(data.bucket, data.prefix, data.list.nextToken ?? undefined)}>
							Next page
						</Button>
					</div>
				{/if}
			{/if}
		{/if}
	{/if}
</div>

<Dialog.Root bind:open={shareOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2"><LinkIcon class="size-4 text-muted-foreground" />Share “{shareKey}”</Dialog.Title>
			<Dialog.Description>
				The link is signed by the server and never contains a key. Private instances go through the
				platform gateway; a download limit is counted there.
			</Dialog.Description>
		</Dialog.Header>
		<Field.Group>
			<Field.Field>
				<Field.Label for="share-expiry">Expires</Field.Label>
				<NativeSelect.Root id="share-expiry" bind:value={shareExpiry} class="w-full">
					<NativeSelect.Option value="3600">1 hour</NativeSelect.Option>
					<NativeSelect.Option value="86400">1 day</NativeSelect.Option>
					<NativeSelect.Option value="604800">7 days (maximum)</NativeSelect.Option>
				</NativeSelect.Root>
			</Field.Field>
			<Field.Field>
				<Field.Label for="share-limit">Download limit</Field.Label>
				<Input id="share-limit" bind:value={shareLimit} placeholder="Unlimited" inputmode="numeric" />
				<Field.Description>Optional; GET links only.</Field.Description>
			</Field.Field>
		</Field.Group>
		<Dialog.Footer>
			<Dialog.Close>
				{#snippet child({ props })}
					<Button variant="outline" {...props} disabled={shareBusy}>Cancel</Button>
				{/snippet}
			</Dialog.Close>
			<Button onclick={createShare} disabled={shareBusy}>
				{shareBusy ? 'Creating…' : 'Create and copy link'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<script lang="ts">
	/* Browser links are `?bucket=&prefix=` on this same resolved route. */
	/* eslint svelte/no-navigation-without-resolve: ['error', { ignoreLinks: true, ignoreGoto: true }] */
	import { beforeNavigate, goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CloudUploadIcon from '@lucide/svelte/icons/cloud-upload';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import EarthIcon from '@lucide/svelte/icons/earth';
	import FileIcon from '@lucide/svelte/icons/file';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import FolderPlusIcon from '@lucide/svelte/icons/folder-plus';
	import FolderUpIcon from '@lucide/svelte/icons/folder-up';
	import LinkIcon from '@lucide/svelte/icons/link';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import XIcon from '@lucide/svelte/icons/x';
	import { toast } from 'svelte-sonner';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as ButtonGroup from '#lib/components/ui/button-group/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import RowMenu from '../../../_lib/RowMenu.svelte';
	import { formatBytes, formatDateTime, formatRelative } from '../../../_lib/format.js';
	import StorageHeader from '../../_lib/StorageHeader.svelte';
	import { fileIcon } from './_lib/file-icon.js';
	import { dragHasFiles, fromDataTransfer, fromFileList, type Picked } from './_lib/picked.js';
	import { UploadQueue } from './_lib/upload-queue.svelte.js';
	import UploadPanel from './_lib/UploadPanel.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let selected = $state<Set<string>>(new Set());
	let filter = $state('');
	const needle = $derived(filter.trim().toLowerCase());
	const visibleName = (key: string) =>
		data.prefix && key.startsWith(data.prefix) ? key.slice(data.prefix.length) : key;
	const prefixes = $derived(
		(data.list?.prefixes ?? []).filter(
			(prefix) => !needle || visibleName(prefix).toLowerCase().includes(needle)
		)
	);
	const objects = $derived(
		(data.list?.objects ?? []).filter(
			(object) => !needle || visibleName(object.key).toLowerCase().includes(needle)
		)
	);
	const objectKeys = $derived(objects.map((object) => object.key));
	const allSelected = $derived(
		objectKeys.length > 0 && objectKeys.every((key) => selected.has(key))
	);
	const someSelected = $derived(!allSelected && objectKeys.some((key) => selected.has(key)));
	const selectedBytes = $derived(
		(data.list?.objects ?? [])
			.filter((object) => selected.has(object.key))
			.reduce((sum, object) => sum + object.sizeBytes, 0)
	);
	const pageBytes = $derived(
		(data.list?.objects ?? []).reduce((sum, object) => sum + object.sizeBytes, 0)
	);
	const currentBucket = $derived(data.buckets.find((item) => item.name === data.bucket) ?? null);
	const isEmpty = $derived(
		!!data.list && data.list.objects.length === 0 && data.list.prefixes.length === 0
	);

	// A new bucket/prefix is a new view; selections and filters from the previous one must not leak.
	let lastView = '';
	$effect(() => {
		const view = `${data.bucket ?? ''}|${data.prefix}`;
		if (view !== lastView) {
			lastView = view;
			selected = new Set();
			filter = '';
		}
	});

	function href(bucket: string, prefix = '', token?: string): string {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a one-off string builder
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
	const parentPrefix = $derived(crumbs.length > 1 ? crumbs[crumbs.length - 2]!.prefix : '');

	function toggle(key: string, value: boolean) {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced wholesale, not mutated
		const next = new Set(selected);
		if (value) next.add(key);
		else next.delete(key);
		selected = next;
	}

	function toggleAll(value: boolean) {
		selected = value && !allSelected ? new Set(objectKeys) : new Set();
	}

	/** Clicks on a row's own controls (links, buttons, menus, checkboxes) aren't row clicks. */
	function isControl(event: MouseEvent): boolean {
		return !!(event.target as Element | null)?.closest(
			'a, button, input, label, [role="menuitem"], [role="checkbox"]'
		);
	}

	async function copyKey(key: string) {
		await navigator.clipboard.writeText(key);
		toast.success('Key copied to the clipboard.');
	}

	let refreshing = $state(false);
	async function refresh() {
		refreshing = true;
		await invalidateAll();
		refreshing = false;
	}

	function deleteObject(key: string) {
		if (!data.bucket) return;
		askConfirm({
			title: `Delete “${visibleName(key)}”?`,
			description: `${key} is removed from ${data.bucket}. This cannot be undone.`,
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
			description: `The selected objects are removed from ${data.bucket}. This cannot be undone.`,
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

	function removeFolder(prefix: string) {
		if (!data.bucket) return;
		askConfirm({
			title: `Delete the folder “${prefix.slice(data.prefix.length)}”?`,
			description:
				'Only the folder marker is deleted; objects inside it are kept. Empty it first if you want the prefix gone.',
			confirmLabel: 'Delete folder marker',
			tone: 'danger',
			action: '?/delete',
			fields: { bucket: data.bucket, key: prefix, prefix: data.prefix }
		});
	}

	// --- uploads -------------------------------------------------------------------------------

	const queue = new UploadQueue({
		storage: () => data.storage.name,
		maxBytes: () => data.maxUploadBytes,
		onProgress: () => void invalidateAll(),
		onDrained: ({ done, failed }) => {
			void invalidateAll();
			if (failed > 0)
				toast.error(`${failed} upload${failed === 1 ? '' : 's'} failed.`, {
					description: done > 0 ? `${done} uploaded.` : undefined
				});
			else if (done > 0) toast.success(`Uploaded ${done} item${done === 1 ? '' : 's'}.`);
		}
	});

	let fileInput = $state<HTMLInputElement | null>(null);
	let folderInput = $state<HTMLInputElement | null>(null);

	function enqueue(picked: Picked, prefix = data.prefix) {
		if (!data.bucket) return;
		if (picked.files.length === 0 && picked.emptyFolders.length === 0) {
			toast.error('Nothing to upload: the selection had no files.');
			return;
		}
		queue.add(data.bucket, prefix, picked);
	}

	function onPicked(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		if (input.files) enqueue(fromFileList(input.files));
		input.value = '';
	}

	// Drag and drop: the whole browser card is a drop zone, and a folder row targets that folder.
	let dragDepth = $state(0);
	let dropPrefix = $state<string | null>(null);
	const dragging = $derived(dragDepth > 0);
	const dropLabel = $derived(`${data.bucket ?? ''}/${dropPrefix ?? data.prefix}`);

	function onDragEnter(event: DragEvent) {
		if (!data.canWrite || !dragHasFiles(event)) return;
		event.preventDefault();
		dragDepth += 1;
	}

	function onDragOver(event: DragEvent) {
		if (!data.canWrite || !dragHasFiles(event)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
		const row = (event.target as Element | null)?.closest('[data-drop-prefix]');
		dropPrefix = row?.getAttribute('data-drop-prefix') ?? null;
	}

	function onDragLeave(event: DragEvent) {
		if (!data.canWrite || !dragHasFiles(event)) return;
		dragDepth = Math.max(0, dragDepth - 1);
		if (dragDepth === 0) dropPrefix = null;
	}

	async function onDrop(event: DragEvent) {
		if (!data.canWrite || !dragHasFiles(event) || !event.dataTransfer) return;
		event.preventDefault();
		const target = dropPrefix ?? data.prefix;
		dragDepth = 0;
		dropPrefix = null;
		try {
			enqueue(await fromDataTransfer(event.dataTransfer), target);
		} catch {
			toast.error('Could not read the dropped files.');
		}
	}

	// A file dropped anywhere else on the page would make the browser navigate to it.
	function swallowStrayDrop(event: DragEvent) {
		if (dragHasFiles(event)) event.preventDefault();
	}

	beforeNavigate((navigation) => {
		if (!queue.running) return;
		const staysHere =
			navigation.to?.route.id === page.route.id &&
			navigation.to?.params?.name === data.storage.name;
		if (staysHere) return;
		if (navigation.type === 'leave') {
			navigation.cancel();
			return;
		}
		if (window.confirm('Uploads are still running. Leave this page and cancel them?'))
			queue.cancelAll();
		else navigation.cancel();
	});

	// --- folders -------------------------------------------------------------------------------

	let folderOpen = $state(false);
	let folderName = $state('');

	function openFolder() {
		folderName = '';
		folderOpen = true;
	}

	// --- share links ---------------------------------------------------------------------------

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
		};
		shareBusy = false;
		if (!response.ok || !body.url) {
			toast.error(body.message ?? 'Could not create a share link.');
			return;
		}
		await navigator.clipboard.writeText(body.url);
		shareOpen = false;
		toast.success(
			`Share link copied. It works until ${new Date(body.expiresAt ?? Date.now()).toLocaleString()}` +
				`${limit ? ` for ${limit} download${limit === 1 ? '' : 's'}` : ''}.`
		);
	}
</script>

<svelte:head>
	<title>Objects · {data.storage.name} · Skiff</title>
</svelte:head>

<svelte:window ondragover={swallowStrayDrop} ondrop={swallowStrayDrop} />

{#snippet uploadButtons(size: 'sm' | 'default')}
	<ButtonGroup.Root>
		<Button {size} onclick={() => fileInput?.click()}><UploadIcon />Upload</Button>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} {size} class="px-2!" aria-label="More upload options">
						<ChevronDownIcon />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-44">
				<DropdownMenu.Item onSelect={() => fileInput?.click()}>
					<UploadIcon />Files…
				</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={() => folderInput?.click()}>
					<FolderUpIcon />Folder…
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</ButtonGroup.Root>
{/snippet}

<div class="space-y-6">
	<StorageHeader st={data.storage} can={data.storageCan} active="objects" />

	{#if data.buckets.length === 0}
		<EmptyState
			icon={ArchiveIcon}
			title="No buckets to browse"
			description="Create a bucket first. A bucket that is being deleted can't be browsed."
		>
			<Button
				variant="outline"
				href="{resolve('/(dashboard)/storage/[name]', { name: data.storage.name })}?tab=buckets"
			>
				<ArchiveIcon />Go to buckets
			</Button>
		</EmptyState>
	{:else if data.bucket}
		<div
			role="region"
			aria-label="Objects in {data.bucket}"
			class="relative overflow-hidden rounded-xl border bg-card shadow-xs"
			ondragenter={onDragEnter}
			ondragover={onDragOver}
			ondragleave={onDragLeave}
			ondrop={onDrop}
		>
			<!-- Toolbar: bucket, path, actions -->
			<div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2.5">
				<NativeSelect.Root
					value={data.bucket}
					onchange={(event) => goto(href((event.currentTarget as HTMLSelectElement).value))}
					class="w-48"
					aria-label="Bucket"
				>
					{#each data.buckets as item (item.name)}
						<NativeSelect.Option value={item.name}>
							{item.name}{item.access === 'public-read' ? ' (public)' : ''}
						</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>

				<nav aria-label="Folder path" class="flex min-w-0 flex-1 items-center gap-0.5 text-sm">
					{#if crumbs.length > 0}
						<Button
							variant="ghost"
							size="icon-sm"
							href={href(data.bucket, parentPrefix)}
							aria-label="Up one folder"
							title="Up one folder"
						>
							<ChevronLeftIcon />
						</Button>
					{/if}
					<a
						href={href(data.bucket)}
						class="shrink-0 rounded px-1.5 py-0.5 font-mono text-xs {crumbs.length === 0
							? 'font-medium text-foreground'
							: 'text-muted-foreground hover:text-foreground'}"
					>
						{data.bucket}
					</a>
					{#each crumbs as crumb, index (crumb.prefix)}
						<ChevronRightIcon class="size-3.5 shrink-0 text-muted-foreground" />
						<a
							href={href(data.bucket, crumb.prefix)}
							aria-current={index === crumbs.length - 1 ? 'page' : undefined}
							class="truncate rounded px-1.5 py-0.5 font-mono text-xs {index === crumbs.length - 1
								? 'font-medium text-foreground'
								: 'text-muted-foreground hover:text-foreground'}"
						>
							{crumb.name}
						</a>
					{/each}
					{#if currentBucket?.access === 'public-read'}
						<Badge variant="info" class="ml-1.5"><EarthIcon />Public read</Badge>
					{/if}
				</nav>

				<div class="ml-auto flex items-center gap-2">
					{#if data.list && !isEmpty}
						<InputGroup.Root class="h-8 w-44">
							<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
							<InputGroup.Input
								bind:value={filter}
								placeholder="Filter this page"
								aria-label="Filter objects by name"
								spellcheck="false"
								class="text-sm"
							/>
							{#if filter}
								<InputGroup.Addon align="inline-end">
									<InputGroup.Button
										size="icon-xs"
										onclick={() => (filter = '')}
										aria-label="Clear filter"
									>
										<XIcon />
									</InputGroup.Button>
								</InputGroup.Addon>
							{/if}
						</InputGroup.Root>
					{/if}
					<Button
						size="icon-sm"
						variant="ghost"
						onclick={refresh}
						disabled={refreshing}
						aria-label="Refresh"
						title="Refresh"
					>
						<RefreshCwIcon class={refreshing ? 'animate-spin' : ''} />
					</Button>
					{#if data.canWrite}
						<Button size="sm" variant="outline" onclick={openFolder}>
							<FolderPlusIcon />New folder
						</Button>
						{@render uploadButtons('sm')}
					{/if}
				</div>
			</div>

			{#if selected.size > 0 && data.canWrite}
				<div class="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
					<span class="text-sm">
						<span class="font-medium tabular-nums">{selected.size}</span>
						{selected.size === 1 ? 'object' : 'objects'} selected
						<span class="text-muted-foreground">· {formatBytes(selectedBytes)}</span>
					</span>
					<div class="flex items-center gap-1.5">
						<Button size="sm" variant="ghost" onclick={() => (selected = new Set())}>
							<XIcon />Clear
						</Button>
						<Button size="sm" variant="destructive" onclick={deleteSelected}>
							<Trash2Icon />Delete selected
						</Button>
					</div>
				</div>
			{/if}

			{#if data.listError}
				<div class="p-4">
					<Notice tone="warning" title="Could not list this bucket">{data.listError}</Notice>
				</div>
			{:else if data.list}
				{#if isEmpty}
					<div class="p-4">
						<EmptyState
							icon={data.canWrite ? CloudUploadIcon : FolderOpenIcon}
							title={data.prefix ? 'This folder is empty' : 'This bucket is empty'}
							description={data.canWrite
								? 'Drag files or whole folders here, or pick them below. Folders keep their structure.'
								: 'There are no objects under this prefix.'}
						>
							{#if data.canWrite}
								<Button size="sm" onclick={() => fileInput?.click()}>
									<UploadIcon />Upload files
								</Button>
								<Button size="sm" variant="outline" onclick={() => folderInput?.click()}>
									<FolderUpIcon />Upload folder
								</Button>
							{/if}
						</EmptyState>
					</div>
				{:else if prefixes.length === 0 && objects.length === 0}
					<div class="px-4 py-10 text-center text-sm text-muted-foreground">
						Nothing on this page matches “{filter.trim()}”.
						<Button variant="link" size="sm" class="px-1" onclick={() => (filter = '')}>
							Clear filter
						</Button>
					</div>
				{:else}
					<Table.Root>
						<Table.Header class="bg-muted/45">
							<Table.Row>
								{#if data.canWrite}
									<Table.Head class="w-0 pr-0 pl-4">
										<Checkbox
											bind:checked={() => allSelected, toggleAll}
											bind:indeterminate={() => someSelected, () => {}}
											disabled={objectKeys.length === 0}
											aria-label="Select all objects on this page"
										/>
									</Table.Head>
								{/if}
								<Table.Head class={data.canWrite ? '' : 'pl-4'}>Name</Table.Head>
								<Table.Head class="hidden text-right sm:table-cell">Size</Table.Head>
								<Table.Head class="hidden md:table-cell">Modified</Table.Head>
								<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each prefixes as prefix (prefix)}
								{@const target = dragging && dropPrefix === prefix}
								<Table.Row
									class="group cursor-pointer {target
										? 'bg-brand/10 outline-2 -outline-offset-2 outline-brand'
										: ''}"
									data-drop-prefix={prefix}
									onclick={(event: MouseEvent) => {
										if (!isControl(event)) goto(href(data.bucket ?? '', prefix));
									}}
								>
									{#if data.canWrite}<Table.Cell class="pr-0 pl-4"></Table.Cell>{/if}
									<Table.Cell class={data.canWrite ? '' : 'pl-4'}>
										<a
											class="inline-flex items-center gap-2 font-mono text-xs font-medium underline-offset-4 group-hover:underline"
											href={href(data.bucket, prefix)}
										>
											{#if target}
												<FolderOpenIcon class="size-4 text-brand" />
											{:else}
												<FolderIcon class="size-4 fill-brand/15 text-brand" />
											{/if}
											{prefix.slice(data.prefix.length)}
										</a>
									</Table.Cell>
									<Table.Cell class="hidden text-right text-xs text-muted-foreground sm:table-cell"
										>—</Table.Cell
									>
									<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell"
										>Folder</Table.Cell
									>
									<Table.Cell class="pr-4">
										<div class="flex justify-end">
											<RowMenu label="Actions for {prefix}">
												<DropdownMenu.Item onSelect={() => goto(href(data.bucket ?? '', prefix))}>
													<FolderOpenIcon />Open folder
												</DropdownMenu.Item>
												<DropdownMenu.Item onSelect={() => copyKey(prefix)}>
													<CopyIcon />Copy prefix
												</DropdownMenu.Item>
												{#if data.canWrite}
													<DropdownMenu.Separator />
													<DropdownMenu.Item
														variant="destructive"
														onSelect={() => removeFolder(prefix)}
													>
														<Trash2Icon />Delete folder marker
													</DropdownMenu.Item>
												{/if}
											</RowMenu>
										</div>
									</Table.Cell>
								</Table.Row>
							{/each}
							{#each objects as object (object.key)}
								{@const checked = selected.has(object.key)}
								{@const Icon = fileIcon(object.key) ?? FileIcon}
								<Table.Row
									data-state={checked ? 'selected' : undefined}
									class={data.canWrite ? 'cursor-pointer' : ''}
									onclick={(event: MouseEvent) => {
										if (data.canWrite && !isControl(event)) toggle(object.key, !checked);
									}}
								>
									{#if data.canWrite}
										<Table.Cell class="pr-0 pl-4">
											<Checkbox
												bind:checked={() => checked, (value) => toggle(object.key, value)}
												aria-label="Select {visibleName(object.key)}"
											/>
										</Table.Cell>
									{/if}
									<Table.Cell class="max-w-0 {data.canWrite ? '' : 'pl-4'}">
										<span class="flex min-w-0 items-center gap-2">
											<Icon class="size-4 shrink-0 text-muted-foreground" />
											<span class="truncate font-mono text-xs" title={object.key}
												>{visibleName(object.key)}</span
											>
										</span>
									</Table.Cell>
									<Table.Cell
										class="hidden text-right font-mono text-xs tabular-nums sm:table-cell"
									>
										{formatBytes(object.sizeBytes)}
									</Table.Cell>
									<Table.Cell
										class="hidden text-xs text-muted-foreground md:table-cell"
										title={object.lastModified ? formatDateTime(object.lastModified) : undefined}
									>
										{object.lastModified ? formatRelative(object.lastModified) : '—'}
									</Table.Cell>
									<Table.Cell class="pr-4">
										<div class="flex items-center justify-end gap-0.5">
											<Button
												size="icon-sm"
												variant="ghost"
												href={downloadHref(object.key)}
												aria-label="Download {visibleName(object.key)}"
												title="Download"
												data-sveltekit-reload
											>
												<DownloadIcon />
											</Button>
											<RowMenu label="Actions for {visibleName(object.key)}">
												<DropdownMenu.Item onSelect={() => openShare(object.key)}>
													<LinkIcon />Create share link…
												</DropdownMenu.Item>
												<DropdownMenu.Item onSelect={() => copyKey(object.key)}>
													<CopyIcon />Copy key
												</DropdownMenu.Item>
												{#if data.canWrite}
													<DropdownMenu.Separator />
													<DropdownMenu.Item
														variant="destructive"
														onSelect={() => deleteObject(object.key)}
													>
														<Trash2Icon />Delete object
													</DropdownMenu.Item>
												{/if}
											</RowMenu>
										</div>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}

				<div
					class="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground"
				>
					<span class="tabular-nums">
						{data.list.prefixes.length}
						{data.list.prefixes.length === 1 ? 'folder' : 'folders'} ·
						{data.list.objects.length}
						{data.list.objects.length === 1 ? 'object' : 'objects'}{data.list.isTruncated
							? ' on this page'
							: ''} · {formatBytes(pageBytes)}
						{#if data.canWrite}
							<span class="hidden sm:inline">
								· Drop files or folders anywhere here to upload (up to {data.maxUploadMb} MB each)
							</span>
						{/if}
					</span>
					{#if data.list.isTruncated && data.list.nextToken}
						<Button
							variant="outline"
							size="sm"
							href={href(data.bucket, data.prefix, data.list.nextToken ?? undefined)}
						>
							Next page<ChevronRightIcon />
						</Button>
					{/if}
				</div>
			{/if}

			{#if dragging}
				<!-- Drop overlay: transparent to the pointer so folder rows can still be targeted. -->
				<div
					class="pointer-events-none absolute inset-0 z-10 rounded-xl border-2 border-dashed border-brand {dropPrefix
						? 'bg-brand/[0.03]'
						: 'bg-brand/[0.07]'}"
				>
					<div class="absolute inset-x-0 bottom-4 flex justify-center">
						<div
							class="flex max-w-[90%] items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground shadow-lg"
						>
							<CloudUploadIcon class="size-4 shrink-0" />
							<span class="truncate">
								Drop to upload to <span class="font-mono text-xs">{dropLabel}</span>
							</span>
						</div>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>

{#if data.canWrite && data.bucket}
	<input bind:this={fileInput} type="file" multiple hidden onchange={onPicked} />
	<input bind:this={folderInput} type="file" webkitdirectory multiple hidden onchange={onPicked} />

	<FormDialog
		bind:open={folderOpen}
		icon={FolderPlusIcon}
		title="New folder"
		description="S3 has no real folders; Skiff writes an empty marker object so the prefix shows up here."
		action="?/folder"
		submitLabel="Create folder"
	>
		<input type="hidden" name="bucket" value={data.bucket} />
		<input type="hidden" name="prefix" value="{data.prefix}{folderName}" />
		<Field.Group>
			<Field.Field>
				<Field.Label for="folder-name">Folder name</Field.Label>
				<InputGroup.Root>
					<InputGroup.Addon>
						<InputGroup.Text class="font-mono text-xs">{data.bucket}/{data.prefix}</InputGroup.Text>
					</InputGroup.Addon>
					<InputGroup.Input
						id="folder-name"
						bind:value={folderName}
						placeholder="photos"
						required
						spellcheck="false"
						class="font-mono text-sm"
					/>
				</InputGroup.Root>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

<UploadPanel {queue} />

<Dialog.Root bind:open={shareOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<LinkIcon class="size-4 text-muted-foreground" />Share {visibleName(shareKey)}
			</Dialog.Title>
			<Dialog.Description>
				The link is signed by the server and never contains a key. Private instances go through the
				platform gateway, which also counts the download limit.
			</Dialog.Description>
		</Dialog.Header>
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="share-expiry">Expires after</Field.Label>
					<NativeSelect.Root id="share-expiry" bind:value={shareExpiry} class="w-full">
						<NativeSelect.Option value="3600">1 hour</NativeSelect.Option>
						<NativeSelect.Option value="86400">1 day</NativeSelect.Option>
						<NativeSelect.Option value="604800">7 days (maximum)</NativeSelect.Option>
					</NativeSelect.Root>
				</Field.Field>
				<Field.Field>
					<Field.Label for="share-limit">Download limit</Field.Label>
					<Input
						id="share-limit"
						bind:value={shareLimit}
						placeholder="Unlimited"
						inputmode="numeric"
						class="font-mono text-sm"
					/>
				</Field.Field>
			</div>
		</Field.Group>
		<Dialog.Footer>
			<Dialog.Close>
				{#snippet child({ props })}
					<Button variant="outline" {...props} disabled={shareBusy}>Cancel</Button>
				{/snippet}
			</Dialog.Close>
			<Button onclick={createShare} disabled={shareBusy}>
				{#if shareBusy}<Spinner />{:else}<LinkIcon />{/if}
				Create and copy link
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

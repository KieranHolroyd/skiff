<script lang="ts">
	import { browser } from '$app/env';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { createQuery } from '@tanstack/svelte-query';
	import type {
		ContainerDirListing,
		ContainerFileEntry,
		ContainerFilePreview,
		ContainerTarget
	} from '@skiff/contracts';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import FileIcon from '@lucide/svelte/icons/file';
	import FileSymlinkIcon from '@lucide/svelte/icons/file-symlink';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import LockIcon from '@lucide/svelte/icons/lock';
	import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import WrapTextIcon from '@lucide/svelte/icons/wrap-text';
	import XIcon from '@lucide/svelte/icons/x';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { errorText, fetchJson, HttpError } from '#lib/query.js';
	import { formatBytes, formatRelative } from '../../../_lib/format.js';
	import CodeEditor from './CodeEditor.svelte';
	import ReplicaPicker from './ReplicaPicker.svelte';

	let {
		slug,
		replica = $bindable<number | null>(null),
		initialPath = '/'
	}: {
		slug: string;
		replica?: number | null;
		initialPath?: string;
	} = $props();

	const base = $derived(`/projects/${encodeURIComponent(slug)}/container`);
	const suffix = $derived(replica === null ? '' : `&replica=${replica}`);

	// svelte-ignore state_referenced_locally
	let path = $state(normalize(initialPath));
	// svelte-ignore state_referenced_locally
	let draft = $state(normalize(initialPath));
	let selected = $state<string | null>(null);
	let wordWrap = $state(false);

	const targetsQuery = createQuery(() => ({
		queryKey: ['container-targets', slug] as const,
		queryFn: ({ signal }) =>
			fetchJson<{ targets: ContainerTarget[] }>(`${base}/targets`, { signal }),
		enabled: browser,
		staleTime: 30_000
	}));

	const listing = createQuery(() => ({
		queryKey: ['container-files', slug, replica, path] as const,
		queryFn: ({ signal }) =>
			fetchJson<{ listing: ContainerDirListing }>(
				`${base}/files?path=${encodeURIComponent(path)}${suffix}`,
				{
					signal,
					cache: 'no-store'
				}
			).then((body) => body.listing),
		enabled: browser,
		staleTime: 5_000,
		retry: false
	}));

	const preview = createQuery(() => ({
		queryKey: ['container-file', slug, replica, selected] as const,
		queryFn: ({ signal }) =>
			fetchJson<{ preview: ContainerFilePreview }>(
				`${base}/files/preview?path=${encodeURIComponent(selected ?? '/')}${suffix}`,
				{ signal, cache: 'no-store' }
			).then((body) => body.preview),
		enabled: browser && selected !== null,
		staleTime: 5_000,
		retry: false
	}));

	// The resolved path (symlinks followed) is what the node actually listed.
	$effect(() => {
		const resolved = listing.data?.path;
		if (resolved && resolved !== path) {
			path = resolved;
			draft = resolved;
		}
	});

	// Keep `?path=` deep-linkable without a navigation.
	$effect(() => {
		const current = path;
		if (!browser || page.url.searchParams.get('path') === current) return;
		const url = new URL(page.url.href);
		if (current === '/') url.searchParams.delete('path');
		else url.searchParams.set('path', current);
		try {
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only `?path` changes
			replaceState(url, page.state);
		} catch {
			// Called before the router is ready; the next change catches up.
		}
	});

	const crumbs = $derived.by(() => {
		const parts = path.split('/').filter(Boolean);
		return [
			{ name: '/', path: '/' },
			...parts.map((name, index) => ({ name, path: `/${parts.slice(0, index + 1).join('/')}` }))
		];
	});

	function normalize(value: string): string {
		const parts: string[] = [];
		for (const part of value.split('/')) {
			if (!part || part === '.') continue;
			if (part === '..') parts.pop();
			else parts.push(part);
		}
		return `/${parts.join('/')}`;
	}

	function join(dir: string, name: string): string {
		return normalize(`${dir}/${name}`);
	}

	function go(next: string): void {
		path = normalize(next);
		draft = path;
	}

	async function openEntry(entry: ContainerFileEntry): Promise<void> {
		const target = join(path, entry.name);
		if (entry.kind === 'directory') return go(target);
		if (entry.kind === 'file') {
			selected = target;
			return;
		}
		if (entry.kind === 'symlink') {
			// The node resolves links inside the container: try it as a directory, else as a file.
			try {
				await fetchJson(`${base}/files?path=${encodeURIComponent(target)}${suffix}`);
				go(target);
			} catch (error) {
				if (error instanceof HttpError && error.status === 400) selected = target;
				else go(target);
			}
		}
	}

	function downloadHref(file: string): string {
		return `${base}/files/download?path=${encodeURIComponent(file)}${suffix}`;
	}

	function icon(entry: ContainerFileEntry) {
		if (entry.kind === 'directory') return FolderIcon;
		if (entry.kind === 'symlink') return FileSymlinkIcon;
		return FileIcon;
	}

	const selectedName = $derived(selected?.split('/').pop() ?? '');
	const desiredId = $derived(
		targetsQuery.data?.targets.find((target) => target.replica === replica)?.desiredId ?? slug
	);
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-center gap-3">
		<ReplicaPicker targets={targetsQuery.data?.targets ?? []} bind:replica />
		<form
			class="flex min-w-64 flex-1 items-center gap-2"
			onsubmit={(event) => {
				event.preventDefault();
				go(draft);
			}}
		>
			<Button
				type="button"
				variant="outline"
				size="icon-sm"
				disabled={path === '/'}
				onclick={() => go(join(path, '..'))}
				title="Up one level"
			>
				<ArrowUpIcon />
			</Button>
			<Input
				bind:value={draft}
				class="h-8 font-mono text-xs"
				spellcheck={false}
				aria-label="Path"
			/>
			<Button
				type="button"
				variant="outline"
				size="icon-sm"
				onclick={() => listing.refetch()}
				title="Refresh"
			>
				{#if listing.isFetching}<Spinner class="size-3.5" />{:else}<RotateCwIcon />{/if}
			</Button>
		</form>
	</div>

	<nav
		class="flex flex-wrap items-center gap-1 font-mono text-xs text-muted-foreground"
		aria-label="Path"
	>
		{#each crumbs as crumb, index (crumb.path)}
			{#if index > 1}<span>/</span>{/if}
			<button
				type="button"
				class="rounded px-1 py-0.5 hover:bg-muted hover:text-foreground {index === crumbs.length - 1
					? 'text-foreground'
					: ''}"
				onclick={() => go(crumb.path)}
			>
				{crumb.name}
			</button>
		{/each}
		{#if listing.data}
			<Badge variant="neutral" class="ml-2">
				{#if listing.data.readOnly}<LockIcon class="size-3" />{/if}
				{listing.data.mount === '/' ? 'image filesystem' : `mount ${listing.data.mount}`}{listing
					.data.readOnly
					? ' · read-only'
					: ''}
			</Badge>
		{/if}
	</nav>

	<div class="grid gap-4 {selected ? 'xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]' : ''}">
		<Card.Root class="gap-0 overflow-hidden py-0">
			{#if listing.isPending}
				<div class="space-y-2 p-4">
					{#each [0, 1, 2, 3, 4, 5] as index (index)}
						<Skeleton class="h-6" />
					{/each}
				</div>
			{:else if listing.isError}
				<div class="flex flex-col items-start gap-3 p-6 text-sm">
					<p class="flex items-center gap-2 font-medium">
						<TriangleAlertIcon class="size-4 text-warning" />Cannot open {path}
					</p>
					<p class="text-muted-foreground">
						{errorText(listing.error, 'The node did not answer.')}
					</p>
					<Button variant="outline" size="sm" onclick={() => go('/')}>Back to /</Button>
				</div>
			{:else if listing.data}
				<div class="max-h-[70vh] overflow-auto">
					<Table.Root>
						<Table.Header class="sticky top-0 z-10 bg-muted/90 backdrop-blur">
							<Table.Row>
								<Table.Head class="pl-4">Name</Table.Head>
								<Table.Head class="w-24 text-right">Size</Table.Head>
								<Table.Head class="hidden w-20 md:table-cell">Mode</Table.Head>
								<Table.Head class="hidden w-24 lg:table-cell">Owner</Table.Head>
								<Table.Head class="hidden w-28 pr-4 sm:table-cell">Modified</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#if listing.data.entries.length === 0}
								<Table.Row>
									<Table.Cell colspan={5} class="py-8 text-center text-sm text-muted-foreground"
										>Empty directory</Table.Cell
									>
								</Table.Row>
							{/if}
							{#each listing.data.entries as entry (entry.name)}
								{@const Icon = icon(entry)}
								{@const full = join(path, entry.name)}
								<Table.Row class={selected === full ? 'bg-brand/5' : ''}>
									<Table.Cell class="max-w-0 pl-4">
										<button
											type="button"
											class="flex w-full min-w-0 items-center gap-2 text-left"
											onclick={() => openEntry(entry)}
											disabled={entry.kind !== 'file' &&
												entry.kind !== 'directory' &&
												entry.kind !== 'symlink'}
										>
											<Icon
												class="size-4 shrink-0 {entry.kind === 'directory'
													? 'text-brand'
													: 'text-muted-foreground'}"
											/>
											<span class="truncate font-mono text-xs">{entry.name}</span>
											{#if entry.linkTarget}
												<span class="truncate font-mono text-xs text-muted-foreground"
													>→ {entry.linkTarget}</span
												>
											{/if}
											{#if entry.kind !== 'file' && entry.kind !== 'directory' && entry.kind !== 'symlink'}
												<Badge variant="neutral" class="text-[10px]">{entry.kind}</Badge>
											{/if}
										</button>
									</Table.Cell>
									<Table.Cell
										class="text-right font-mono text-xs text-muted-foreground tabular-nums"
									>
										{entry.kind === 'file' ? formatBytes(entry.sizeBytes) : ''}
									</Table.Cell>
									<Table.Cell class="hidden font-mono text-xs text-muted-foreground md:table-cell"
										>{entry.mode}</Table.Cell
									>
									<Table.Cell class="hidden font-mono text-xs text-muted-foreground lg:table-cell"
										>{entry.uid}:{entry.gid}</Table.Cell
									>
									<Table.Cell
										class="hidden pr-4 text-xs text-muted-foreground sm:table-cell"
										title={entry.modifiedAt}
									>
										{formatRelative(entry.modifiedAt)}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
				{#if listing.data.truncated}
					<p class="border-t px-4 py-2 text-xs text-muted-foreground">
						Showing the first {listing.data.entries.length.toLocaleString('en-GB')} entries. Use the shell
						to see the rest.
					</p>
				{/if}
			{/if}
		</Card.Root>

		{#if selected}
			<Card.Root class="min-w-0 gap-0 overflow-hidden py-0">
				<div class="flex items-center justify-between gap-2 border-b px-4 py-2">
					<div class="min-w-0">
						<p class="truncate font-mono text-xs font-medium" title={selected}>{selectedName}</p>
						{#if preview.data}
							<p class="text-xs text-muted-foreground">
								{formatBytes(preview.data.sizeBytes)} · modified {formatRelative(
									preview.data.modifiedAt
								)}
							</p>
						{/if}
					</div>
					<div class="flex shrink-0 items-center gap-1">
						<Button
							variant="ghost"
							size="icon-sm"
							onclick={() => (wordWrap = !wordWrap)}
							title="Wrap lines"
							aria-pressed={wordWrap}
						>
							<WrapTextIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							href={downloadHref(selected)}
							download={selectedName}
							title="Download"
						>
							<DownloadIcon />
						</Button>
						<Button variant="ghost" size="icon-sm" onclick={() => (selected = null)} title="Close">
							<XIcon />
						</Button>
					</div>
				</div>
				<div class="h-[min(70vh,640px)]">
					{#if preview.isPending}
						<div class="flex h-full items-center justify-center"><Spinner /></div>
					{:else if preview.isError}
						<div
							class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm"
						>
							<TriangleAlertIcon class="size-5 text-warning" />
							<p class="text-muted-foreground">
								{errorText(preview.error, 'The file could not be read.')}
							</p>
						</div>
					{:else if preview.data && preview.data.content === null}
						<div
							class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm"
						>
							<FileIcon class="size-6 text-muted-foreground" />
							<p class="text-muted-foreground">
								{preview.data.reason === 'binary'
									? 'This looks like a binary file, so it is not shown here.'
									: 'This file is too large to preview (over 1 MiB).'}
							</p>
							<Button
								variant="outline"
								size="sm"
								href={downloadHref(selected)}
								download={selectedName}
							>
								<DownloadIcon />
								Download {formatBytes(preview.data.sizeBytes)}
							</Button>
						</div>
					{:else if preview.data}
						{#key `${desiredId}:${selected}`}
							<CodeEditor
								value={preview.data.content ?? ''}
								path={selected}
								releaseId={`ctr-${desiredId}`}
								{wordWrap}
								minimap={false}
							/>
						{/key}
					{/if}
				</div>
			</Card.Root>
		{/if}
	</div>
	<p class="text-xs text-muted-foreground">
		Read-only view of the running container: the image's filesystem plus its volumes. Secret files
		and in-memory mounts such as /tmp are not shown; use the shell for those. Reads and downloads
		are recorded in the audit log.
	</p>
</div>

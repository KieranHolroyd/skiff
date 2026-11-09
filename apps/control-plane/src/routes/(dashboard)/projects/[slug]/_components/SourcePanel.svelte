<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { browser } from '$app/env';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import FolderCodeIcon from '@lucide/svelte/icons/folder-code';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
	import LockIcon from '@lucide/svelte/icons/lock';
	import MapIcon from '@lucide/svelte/icons/map';
	import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
	import MinusIcon from '@lucide/svelte/icons/minus';
	import PanelLeftIcon from '@lucide/svelte/icons/panel-left';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import WrapTextIcon from '@lucide/svelte/icons/wrap-text';
	import XIcon from '@lucide/svelte/icons/x';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import Spinner from '#lib/components/ui/spinner/spinner.svelte';
	import { errorText, fetchJson, fetchText } from '#lib/query.js';
	import { formatBytes, shortSha } from '../../../_lib/format.js';
	import CodeEditor from './CodeEditor.svelte';
	import {
		MAX_TEXT_BYTES,
		ancestorsOf,
		basename,
		buildTree,
		dirname,
		iconClassFor,
		iconFor,
		isBinary,
		isPreviewableImage,
		languageFor,
		searchFiles,
		sourceFileUrl,
		type DeploymentSummary,
		type SourceView,
		type TreeNode
	} from './source-utils.js';

	let {
		slug,
		deployments,
		productionDeploymentId
	}: {
		slug: string;
		deployments: DeploymentSummary[];
		productionDeploymentId: string | null;
	} = $props();

	type Row = { node: TreeNode; depth: number };

	let selectedId = $state('');
	let initialised = false;
	/** The release whose files the tabs and tree currently describe. */
	let appliedId = '';

	let expanded = $state<Record<string, boolean>>({});
	let filter = $state('');
	let quickOpen = $state(false);
	let quickQuery = $state('');
	let quickIndex = $state(0);
	let quickInput = $state<HTMLInputElement | null>(null);

	let openPaths = $state<string[]>([]);
	let activePath = $state<string | null>(null);

	let wordWrap = $state(false);
	let minimap = $state(true);
	let sidebarOpen = $state(true);
	let cursor = $state({ line: 1, column: 1, selected: 0 });
	let imageZoom = $state(1);
	let imageSize = $state<{ width: number; height: number } | null>(null);
	let imageLoaded = $state(false);

	let panel: HTMLDivElement | null = null;
	let isMac = $state(true);

	// --- data: a release is immutable, so its manifest and files are cached for the session --------

	const queryClient = useQueryClient();

	const manifest = createQuery(() => ({
		queryKey: ['source', slug, selectedId] as const,
		queryFn: ({ signal }) =>
			fetchJson<SourceView>(
				`/projects/${encodeURIComponent(slug)}/source?deployment=${encodeURIComponent(selectedId)}`,
				{ signal, fallback: 'Could not load this release' }
			),
		enabled: browser && selectedId !== '',
		staleTime: Infinity
	}));
	// Only trust a manifest for the release that is selected right now.
	const view = $derived(
		manifest.data && manifest.data.deployment.id === selectedId ? manifest.data : null
	);
	const viewLoading = $derived(manifest.isFetching);
	const viewError = $derived(
		manifest.isError ? errorText(manifest.error, 'This release could not be loaded.') : null
	);

	/** Text files are fetched; images, binaries and oversized files never download their bytes. */
	function isTextual(path: string, size: number): boolean {
		return !isPreviewableImage(path) && !isBinary(path) && size <= MAX_TEXT_BYTES;
	}

	function fileOptions(deployment: string, path: string) {
		return {
			queryKey: ['source-file', slug, deployment, path] as const,
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				fetchText(sourceFileUrl(slug, deployment, path), {
					signal,
					fallback: `Could not load ${path}`
				}),
			staleTime: Infinity,
			gcTime: 10 * 60_000
		};
	}

	const files = $derived(view?.files ?? []);
	const tree = $derived(buildTree(files));
	const activeFile = $derived(files.find((file) => file.path === activePath) ?? null);
	const activeImage = $derived(activePath ? isPreviewableImage(activePath) : false);
	const activeBinary = $derived(
		activePath ? isBinary(activePath) && !isPreviewableImage(activePath) : false
	);
	const activeTooLarge = $derived((activeFile?.size ?? 0) > MAX_TEXT_BYTES);
	const activeTextual = $derived(
		activePath !== null && activeFile !== null && isTextual(activePath, activeFile.size)
	);

	const fileQuery = createQuery(() => ({
		...fileOptions(selectedId, activePath ?? ''),
		enabled: browser && activeTextual
	}));
	const content = $derived(activeTextual ? (fileQuery.data ?? null) : null);
	const contentLoading = $derived(activeTextual && fileQuery.isLoading);
	const contentError = $derived(
		activeTextual && fileQuery.isError
			? errorText(fileQuery.error, 'The file could not be loaded.')
			: null
	);

	/** Warm the cache on hover, so opening a file feels instant. */
	function prefetch(path: string) {
		const file = files.find((entry) => entry.path === path);
		if (!file || !selectedId || !isTextual(path, file.size)) return;
		void queryClient.prefetchQuery(fileOptions(selectedId, path));
	}
	const rows = $derived(visibleRows(tree, expanded));
	const filtered = $derived(filter.trim() ? searchFiles(files, filter) : []);
	const quickResults = $derived(
		searchFiles(files, quickQuery)
			.filter((file) => file.path !== activePath)
			.slice(0, 60)
	);
	const downloadUrl = $derived(
		selectedId
			? `/projects/${encodeURIComponent(slug)}/source/download?deployment=${encodeURIComponent(selectedId)}`
			: ''
	);
	const previewUrl = $derived(view?.deployment.previewUrl ?? null);
	const entries = $derived(
		['index.html', '404.html', 'yoal.json', '_redirects', '_headers', 'robots.txt'].filter(
			(path) => files.some((file) => file.path === path)
		)
	);
	const shortcutLabel = $derived(isMac ? '⌘P' : 'Ctrl P');

	onMount(() => {
		isMac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
		// The explorer competes with the editor on phones; start it collapsed there.
		if (window.matchMedia('(max-width: 639px)').matches) sidebarOpen = false;
		const handler = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
				const key = event.key.toLowerCase();
				if (key === 'p') {
					event.preventDefault();
					toggleQuickOpen();
				} else if (key === 'b') {
					event.preventDefault();
					sidebarOpen = !sidebarOpen;
				}
			}
			if (event.key === 'Escape' && quickOpen) {
				event.preventDefault();
				quickOpen = false;
			}
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	});

	$effect(() => {
		if (initialised) return;
		initialised = true;
		const preferred = deployments.find((item) => item.id === productionDeploymentId);
		selectedId = preferred?.id ?? deployments[0]?.id ?? '';
	});

	// Never resolve a path from one release against another: switching clears the tabs, and the
	// new manifest picks a starting file. A refetch of the same release keeps what is open.
	$effect(() => {
		const id = selectedId;
		const next = view;
		untrack(() => {
			if (id !== appliedId) {
				clearSelection();
				if (next) {
					appliedId = id;
					resetSelection(next);
				}
			} else if (next) keepSelection(next);
		});
	});

	$effect(() => {
		if (quickOpen) void tick().then(() => quickInput?.focus());
	});

	$effect(() => {
		// Reset zoom when switching files.
		void activePath;
		imageZoom = 1;
		imageSize = null;
		imageLoaded = false;
	});

	function clearSelection() {
		openPaths = [];
		activePath = null;
		expanded = {};
		filter = '';
		quickOpen = false;
	}

	/** A refresh keeps the open tabs and active file when they still exist in the new manifest. */
	function keepSelection(next: SourceView) {
		const available = new Set(next.files.map((file) => file.path));
		openPaths = openPaths.filter((path) => available.has(path));
		if (activePath && !available.has(activePath)) activePath = openPaths[0] ?? null;
		primeTree(buildTree(next.files));
	}

	function resetSelection(next: SourceView) {
		clearSelection();
		primeTree(buildTree(next.files));
		const entry =
			next.files.find((file) => file.path === 'index.html')?.path ??
			next.files.find((file) => file.path.endsWith('.html'))?.path ??
			next.files[0]?.path;
		if (entry) selectFile(entry, { focus: false });
	}

	function primeTree(nodes: TreeNode[], depth = 0) {
		for (const node of nodes) {
			if (node.type !== 'dir') continue;
			if (depth < 2) expanded[node.path] = true;
			primeTree(node.children ?? [], depth + 1);
		}
	}

	function visibleRows(nodes: TreeNode[], open: Record<string, boolean>, depth = 0): Row[] {
		const out: Row[] = [];
		for (const node of nodes) {
			out.push({ node, depth });
			if (node.type === 'dir' && open[node.path]) {
				out.push(...visibleRows(node.children ?? [], open, depth + 1));
			}
		}
		return out;
	}

	function toggleDir(path: string) {
		expanded[path] = !expanded[path];
	}

	function selectFile(path: string, options: { focus?: boolean } = {}) {
		if (!files.some((file) => file.path === path)) return;
		if (!openPaths.includes(path)) openPaths = [...openPaths, path];
		activePath = path;
		for (const ancestor of ancestorsOf(path)) expanded[ancestor] = true;
		quickOpen = false;
		cursor = { line: 1, column: 1, selected: 0 };
		if (options.focus !== false) {
			void tick().then(() => {
				panel
					?.querySelector(`[data-source-path="${cssEscape(path)}"]`)
					?.scrollIntoView({ block: 'nearest' });
			});
		}
	}

	function closeTab(path: string) {
		const index = openPaths.indexOf(path);
		const next = [...openPaths];
		next.splice(index, 1);
		openPaths = next;
		if (activePath === path) activePath = next[index] ?? next[index - 1] ?? null;
	}

	function toggleQuickOpen() {
		quickOpen = !quickOpen;
		quickQuery = '';
		quickIndex = 0;
	}

	function onQuickKeydown(event: KeyboardEvent) {
		const count = quickResults.length;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			if (count > 0) quickIndex = (quickIndex + 1) % count;
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			if (count > 0) quickIndex = (quickIndex - 1 + count) % count;
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const chosen = quickResults[quickIndex];
			if (chosen) selectFile(chosen.path);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			quickOpen = false;
		}
	}

	function fileUrl(path: string, download = false): string {
		return sourceFileUrl(slug, selectedId, path, download);
	}

	async function copy(text: string, message = 'Copied to the clipboard.') {
		try {
			await navigator.clipboard.writeText(text);
			toast.success(message);
		} catch {
			toast.error('The clipboard is not available.');
		}
	}

	function refresh() {
		if (!selectedId) return;
		void queryClient.invalidateQueries({ queryKey: ['source', slug, selectedId] });
		void queryClient.invalidateQueries({ queryKey: ['source-file', slug, selectedId] });
	}

	function retryFile() {
		void fileQuery.refetch();
	}

	function zoom(delta: number) {
		imageZoom = Math.min(4, Math.max(0.25, Number((imageZoom + delta).toFixed(2))));
	}

	function cssEscape(value: string): string {
		return value.replace(/["\\]/g, '\\$&');
	}

	function deploymentLabel(deployment: DeploymentSummary): string {
		return deployment.isProduction
			? `${deployment.shortId} · production`
			: `${deployment.shortId} · ${deployment.environmentName}`;
	}

	function visiblePath(path: string): string {
		const dir = dirname(path);
		return dir ? `${dir}/` : '';
	}
</script>

<div class="space-y-3">
	<div
		class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-3 py-2 shadow-xs"
	>
		<div class="flex items-center gap-2">
			<span
				class="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
			>
				<FolderTreeIcon class="size-4" />
			</span>
			<div class="leading-tight">
				<p class="text-sm font-medium">Source</p>
				<p class="font-mono text-xs text-muted-foreground">release browser</p>
			</div>
		</div>

		<div class="hidden h-6 w-px bg-border sm:block"></div>

		<NativeSelect.Root
			size="sm"
			class="max-w-64 min-w-0"
			aria-label="Deployment"
			bind:value={selectedId}
		>
			{#each deployments as deployment (deployment.id)}
				<NativeSelect.Option value={deployment.id}
					>{deploymentLabel(deployment)}</NativeSelect.Option
				>
			{/each}
		</NativeSelect.Root>

		{#if view}
			<div class="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
				<button
					type="button"
					class="rounded font-mono underline-offset-4 hover:text-foreground hover:underline"
					title="Copy the release SHA-256"
					onclick={() => view && copy(view.release.sha256, 'Release SHA copied.')}
				>
					{shortSha(view.release.sha256, 12)}
				</button>
				<span class="text-border">·</span>
				<span>{view.files.length} files</span>
				<span class="text-border">·</span>
				<span>{formatBytes(view.release.sizeBytes)}</span>
				{#if view.release.precompressed}
					<Badge variant="outline" class="ml-0.5 h-4 px-1 font-mono text-xs">br+gz</Badge>
				{/if}
			</div>
		{/if}

		<div class="ml-auto flex items-center gap-1.5">
			{#if previewUrl}
				<Button
					variant="ghost"
					size="sm"
					href={previewUrl}
					target="_blank"
					rel="external noreferrer"
				>
					<ArrowUpRightIcon />
					<span class="hidden sm:inline">Open site</span>
				</Button>
			{/if}
			<Button variant="outline" size="sm" href={downloadUrl} download disabled={!selectedId}>
				<DownloadIcon />
				<span class="hidden sm:inline">Download .zip</span>
			</Button>
		</div>
	</div>

	<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
		<div class="flex h-[clamp(480px,calc(100vh-300px),820px)] flex-col">
			<div class="flex h-10 shrink-0 items-center gap-1.5 border-b bg-muted/25 px-2">
				<Button
					variant="ghost"
					size="icon-xs"
					title={sidebarOpen ? 'Hide explorer (⌘B)' : 'Show explorer (⌘B)'}
					aria-label={sidebarOpen ? 'Hide explorer' : 'Show explorer'}
					onclick={() => (sidebarOpen = !sidebarOpen)}
				>
					<PanelLeftIcon />
				</Button>
				<div class="mx-1 h-4 w-px bg-border"></div>
				{#if activePath}
					<div class="flex min-w-0 items-center gap-0.5 font-mono text-xs">
						{#each activePath.split('/') as segment, index (index)}
							{#if index > 0}
								<ChevronRightIcon class="size-3 shrink-0 text-muted-foreground/60" />
							{/if}
							<span
								class={index === activePath.split('/').length - 1
									? 'truncate font-medium text-foreground'
									: 'hidden truncate text-muted-foreground sm:inline'}>{segment}</span
							>
						{/each}
					</div>
				{:else}
					<span class="font-mono text-xs text-muted-foreground">No file open</span>
				{/if}
				<div class="ml-auto flex items-center gap-0.5">
					{#if activePath}
						<Button
							variant="ghost"
							size="icon-xs"
							title="Copy relative path"
							aria-label="Copy relative path"
							onclick={() => copy(activePath ?? '', 'Path copied.')}
						>
							<CopyIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon-xs"
							href={fileUrl(activePath, true)}
							download
							title="Download this file"
							aria-label="Download this file"
						>
							<DownloadIcon />
						</Button>
						<div class="mx-1 h-4 w-px bg-border"></div>
					{/if}
					<Button
						variant="ghost"
						size="icon-xs"
						class={wordWrap ? 'bg-muted text-foreground' : ''}
						title="Toggle word wrap"
						aria-label="Toggle word wrap"
						aria-pressed={wordWrap}
						onclick={() => (wordWrap = !wordWrap)}
					>
						<WrapTextIcon />
					</Button>
					<Button
						variant="ghost"
						size="icon-xs"
						class={minimap ? 'bg-muted text-foreground' : ''}
						title="Toggle minimap"
						aria-label="Toggle minimap"
						aria-pressed={minimap}
						onclick={() => (minimap = !minimap)}
					>
						<MapIcon />
					</Button>
					<Button
						variant="ghost"
						size="icon-xs"
						title="Reload release"
						aria-label="Reload release"
						onclick={refresh}
					>
						<RotateCwIcon />
					</Button>
				</div>
			</div>

			<div class="flex min-h-0 flex-1">
				{#if sidebarOpen}
					<aside class="flex w-60 shrink-0 flex-col border-r bg-muted/10">
						<div class="flex h-9 shrink-0 items-center justify-between border-b px-3">
							<span class="text-xs font-medium text-muted-foreground">Explorer</span>
							<span class="font-mono text-xs text-muted-foreground tabular-nums"
								>{files.length}</span
							>
						</div>
						<div class="border-b p-2">
							<div class="relative">
								<SearchIcon
									class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
								/>
								<Input
									bind:value={filter}
									placeholder="Filter files"
									class="h-7 pl-7 font-mono text-xs"
									aria-label="Filter files"
								/>
								{#if filter}
									<button
										type="button"
										class="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
										aria-label="Clear filter"
										onclick={() => (filter = '')}
									>
										<XIcon class="size-3" />
									</button>
								{/if}
							</div>
						</div>
						<div class="min-h-0 flex-1 overflow-auto py-1">
							{#if viewLoading}
								<div class="space-y-1.5 p-2">
									{#each Array(8) as row, index (index)}
										<Skeleton class="h-5 w-full" style={`animation-delay: ${row * 40}ms`} />
									{/each}
								</div>
							{:else if viewError}
								<div class="space-y-2 p-3 text-xs">
									<p class="flex items-start gap-1.5 text-destructive">
										<AlertTriangleIcon class="mt-0.5 size-3.5 shrink-0" />
										{viewError}
									</p>
									<Button variant="outline" size="sm" onclick={refresh}>Retry</Button>
								</div>
							{:else if filter.trim()}
								{#if filtered.length === 0}
									<p class="p-3 text-xs text-muted-foreground">No files match “{filter}”.</p>
								{:else}
									{#each filtered as file (file.path)}
										{@const FileIcon = iconFor(file.path)}
										<button
											type="button"
											data-source-path={file.path}
											class="flex w-full items-center gap-1.5 px-2 py-1 text-left font-mono text-xs transition-colors hover:bg-muted/70 {file.path ===
											activePath
												? 'bg-brand/5 text-foreground'
												: 'text-foreground/85'}"
											onclick={() => selectFile(file.path)}
											onpointerenter={() => prefetch(file.path)}
											title={file.path}
										>
											<FileIcon class="size-3.5 shrink-0 {iconClassFor(file.path)}" />
											<span class="truncate">{basename(file.path)}</span>
											<span class="ml-auto shrink-0 truncate text-xs text-muted-foreground/70"
												>{visiblePath(file.path)}</span
											>
										</button>
									{/each}
								{/if}
							{:else if rows.length === 0}
								<p class="p-3 text-xs text-muted-foreground">This release has no files.</p>
							{:else}
								{#each rows as { node, depth } (node.path)}
									{#if node.type === 'dir'}
										<button
											type="button"
											data-source-path={node.path}
											class="flex w-full items-center gap-1 py-1 pr-2 text-left font-mono text-xs text-foreground/85 transition-colors hover:bg-muted/70"
											style:padding-left={`${6 + depth * 12}px`}
											onclick={() => toggleDir(node.path)}
											aria-expanded={!!expanded[node.path]}
										>
											{#if expanded[node.path]}
												<ChevronDownIcon class="size-3 shrink-0 text-muted-foreground" />
												<FolderOpenIcon class="size-3.5 shrink-0 text-muted-foreground" />
											{:else}
												<ChevronRightIcon class="size-3 shrink-0 text-muted-foreground" />
												<FolderIcon class="size-3.5 shrink-0 text-muted-foreground" />
											{/if}
											<span class="truncate">{node.name}</span>
										</button>
									{:else}
										{@const FileIcon = iconFor(node.path)}
										<button
											type="button"
											data-source-path={node.path}
											class="group flex w-full items-center gap-1.5 py-1 pr-2 text-left font-mono text-xs transition-colors hover:bg-muted/70 {node.path ===
											activePath
												? 'bg-brand/5 text-foreground'
												: 'text-foreground/85'}"
											style:padding-left={`${6 + depth * 12 + 16}px`}
											onclick={() => selectFile(node.path)}
											onpointerenter={() => prefetch(node.path)}
											title={node.path}
										>
											<FileIcon class="size-3.5 shrink-0 {iconClassFor(node.path)}" />
											<span class="truncate">{node.name}</span>
										</button>
									{/if}
								{/each}
							{/if}
						</div>
					</aside>
				{/if}

				<section class="flex min-w-0 flex-1 flex-col">
					{#if openPaths.length > 0}
						<div
							class="flex h-9 shrink-0 [scrollbar-width:none] items-stretch overflow-x-auto border-b bg-muted/20"
						>
							{#each openPaths as path (path)}
								{@const TabIcon = iconFor(path)}
								<div
									class="group flex shrink-0 items-center border-r {path === activePath
										? 'border-t-2 border-t-brand bg-card'
										: 'border-t-2 border-t-transparent bg-transparent hover:bg-muted/40'}"
								>
									<button
										type="button"
										class="flex max-w-52 items-center gap-1.5 py-1.5 pr-1 pl-2.5 font-mono text-xs {path ===
										activePath
											? 'text-foreground'
											: 'text-muted-foreground'}"
										onclick={() => selectFile(path)}
										title={path}
									>
										<TabIcon class="size-3.5 shrink-0 {iconClassFor(path)}" />
										<span class="truncate">{basename(path)}</span>
									</button>
									<button
										type="button"
										class="mr-1 rounded p-0.5 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 {path ===
										activePath
											? 'opacity-100'
											: ''}"
										aria-label={`Close ${basename(path)}`}
										onclick={() => closeTab(path)}
									>
										<XIcon class="size-3" />
									</button>
								</div>
							{/each}
							<div class="ml-auto flex items-center pr-2">
								<Button
									variant="ghost"
									size="icon-xs"
									title="Quick open (⌘P)"
									aria-label="Quick open"
									onclick={toggleQuickOpen}
								>
									<SearchIcon />
								</Button>
							</div>
						</div>
					{/if}

					<div class="relative min-h-0 flex-1">
						{#if viewLoading && !view}
							<div class="grid h-full place-items-center">
								<span class="flex items-center gap-2 font-mono text-xs text-muted-foreground">
									<Spinner class="size-3.5" /> Loading release
								</span>
							</div>
						{:else if viewError}
							<div class="grid h-full place-items-center p-6 text-center">
								<div class="max-w-sm space-y-3">
									<AlertTriangleIcon class="mx-auto size-6 text-destructive" />
									<p class="text-sm font-medium">Could not load this release</p>
									<p class="text-xs text-muted-foreground">{viewError}</p>
									<Button variant="outline" size="sm" onclick={refresh}>Try again</Button>
								</div>
							</div>
						{:else if !activePath}
							<div class="grid h-full place-items-center p-6">
								<div class="max-w-md space-y-4 text-center">
									<div
										class="mx-auto flex size-12 shrink-0 items-center justify-center rounded-md bg-muted text-brand"
									>
										<FolderCodeIcon class="size-6" />
									</div>
									<div class="space-y-1">
										<p class="text-sm font-medium">Browse the deployed source</p>
										<p class="text-xs leading-relaxed text-muted-foreground">
											A read-only snapshot of {view ? view.deployment.shortId : 'this release'}.
											Pick a file from the explorer or jump straight to one.
										</p>
									</div>
									{#if entries.length > 0}
										<div class="flex flex-wrap justify-center gap-1.5">
											{#each entries as path (path)}
												{@const EntryIcon = iconFor(path)}
												<Button
													variant="outline"
													size="sm"
													class="font-mono"
													onclick={() => selectFile(path)}
												>
													<EntryIcon class="size-3.5 {iconClassFor(path)}" />
													{path}
												</Button>
											{/each}
										</div>
									{/if}
									<p class="font-mono text-xs text-muted-foreground">
										Press
										<kbd class="rounded border bg-muted px-1 py-0.5">{shortcutLabel}</kbd>
										to quick-open a file
									</p>
								</div>
							</div>
						{:else if activeImage}
							<div class="relative h-full">
								<div class="absolute inset-0 overflow-auto">
									<div class="grid min-h-full min-w-full place-items-center p-6">
										{#if !imageLoaded}
											<Spinner class="size-5 text-muted-foreground" />
										{/if}
										<img
											src={fileUrl(activePath)}
											alt={basename(activePath)}
											class={imageLoaded ? 'block shadow-lg' : 'hidden'}
											style:width={imageSize ? `${imageSize.width * imageZoom}px` : undefined}
											style:max-width={imageZoom === 1 ? '100%' : 'none'}
											style:height="auto"
											onload={(event) => {
												const img = event.currentTarget as HTMLImageElement;
												imageSize = { width: img.naturalWidth, height: img.naturalHeight };
												imageLoaded = true;
											}}
										/>
									</div>
								</div>
								<div
									class="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-lg border bg-popover/95 p-1 shadow-lg backdrop-blur"
								>
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label="Zoom out"
										onclick={() => zoom(-0.25)}
									>
										<MinusIcon />
									</Button>
									<span class="w-12 text-center font-mono text-xs tabular-nums"
										>{Math.round(imageZoom * 100)}%</span
									>
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label="Zoom in"
										onclick={() => zoom(0.25)}
									>
										<PlusIcon />
									</Button>
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label="Fit image"
										onclick={() => (imageZoom = 1)}
									>
										<Maximize2Icon />
									</Button>
								</div>
							</div>
						{:else if activeBinary}
							{@const ActiveIcon = iconFor(activePath ?? '')}
							<div class="grid h-full place-items-center p-6 text-center">
								<div class="max-w-sm space-y-3">
									<div
										class="mx-auto flex size-11 shrink-0 items-center justify-center rounded-md bg-muted"
									>
										<ActiveIcon class="size-5 {iconClassFor(activePath ?? '')}" />
									</div>
									<div class="space-y-1">
										<p class="text-sm font-medium">No text preview</p>
										<p class="text-xs text-muted-foreground">
											<span class="font-mono">{basename(activePath)}</span>
											is {formatBytes(activeFile?.size)} and is not editable source.
										</p>
									</div>
									<Button variant="outline" size="sm" href={fileUrl(activePath, true)} download>
										<DownloadIcon />
										Download file
									</Button>
								</div>
							</div>
						{:else if activeTooLarge}
							<div class="grid h-full place-items-center p-6 text-center">
								<div class="max-w-sm space-y-3">
									<div
										class="mx-auto flex size-11 shrink-0 items-center justify-center rounded-md bg-muted"
									>
										<AlertTriangleIcon class="size-5 text-warning" />
									</div>
									<div class="space-y-1">
										<p class="text-sm font-medium">File is too large to preview</p>
										<p class="text-xs text-muted-foreground">
											<span class="font-mono">{basename(activePath)}</span>
											is {formatBytes(activeFile?.size)}; the editor opens files up to
											{formatBytes(MAX_TEXT_BYTES)}.
										</p>
									</div>
									<Button variant="outline" size="sm" href={fileUrl(activePath, true)} download>
										<DownloadIcon />
										Download file
									</Button>
								</div>
							</div>
						{:else if contentLoading}
							<div class="grid h-full place-items-center">
								<span class="flex items-center gap-2 font-mono text-xs text-muted-foreground">
									<Spinner class="size-3.5" /> Loading {basename(activePath)}
								</span>
							</div>
						{:else if contentError}
							<div class="grid h-full place-items-center p-6 text-center">
								<div class="max-w-sm space-y-3">
									<AlertTriangleIcon class="mx-auto size-6 text-destructive" />
									<p class="text-sm font-medium">Could not load this file</p>
									<p class="text-xs text-muted-foreground">{contentError}</p>
									<Button variant="outline" size="sm" onclick={retryFile}>Try again</Button>
								</div>
							</div>
						{:else if content !== null}
							{#key `${selectedId}:${activePath}`}
								<CodeEditor
									value={content}
									path={activePath}
									releaseId={selectedId}
									{wordWrap}
									{minimap}
									oncursor={(position) => (cursor = position)}
								/>
							{/key}
						{/if}

						{#if quickOpen}
							<div
								class="absolute inset-0 z-30 flex justify-center bg-background/55 px-4 pt-[9vh] backdrop-blur-[1.5px]"
								role="presentation"
								onclick={(event) => {
									if (event.target === event.currentTarget) quickOpen = false;
								}}
							>
								<div
									class="h-fit w-full max-w-lg overflow-hidden rounded-xl border bg-popover shadow-2xl"
									role="dialog"
									aria-label="Quick open"
								>
									<div class="flex items-center gap-2 border-b px-3">
										<SearchIcon class="size-4 shrink-0 text-muted-foreground" />
										<input
											bind:this={quickInput}
											bind:value={quickQuery}
											onkeydown={onQuickKeydown}
											oninput={() => (quickIndex = 0)}
											placeholder="Search files by path"
											class="h-11 min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground"
											aria-label="Search files"
											autocomplete="off"
											spellcheck="false"
										/>
										<kbd
											class="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
											>esc</kbd
										>
									</div>
									<div class="max-h-80 overflow-auto py-1">
										{#if quickResults.length === 0}
											<p class="px-3 py-6 text-center text-xs text-muted-foreground">
												{quickQuery
													? `No files match “${quickQuery}”.`
													: 'No files in this release.'}
											</p>
										{:else}
											{#each quickResults as file, index (file.path)}
												{@const QuickIcon = iconFor(file.path)}
												<button
													type="button"
													class="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs {index ===
													quickIndex
														? 'bg-brand/5 text-foreground'
														: 'text-foreground/85 hover:bg-muted/60'}"
													onmouseenter={() => (quickIndex = index)}
													onclick={() => selectFile(file.path)}
													onpointerenter={() => prefetch(file.path)}
												>
													<QuickIcon class="size-3.5 shrink-0 {iconClassFor(file.path)}" />
													<span class="truncate">{basename(file.path)}</span>
													<span class="ml-auto shrink-0 truncate text-xs text-muted-foreground"
														>{visiblePath(file.path)}</span
													>
												</button>
											{/each}
										{/if}
									</div>
									<div
										class="flex items-center gap-3 border-t px-3 py-1.5 font-mono text-xs text-muted-foreground"
									>
										<span>↑↓ navigate</span><span>↵ open</span><span class="ml-auto"
											>{quickResults.length} file{quickResults.length === 1 ? '' : 's'}</span
										>
									</div>
								</div>
							</div>
						{/if}
					</div>

					<div
						class="flex h-7 shrink-0 items-center justify-between gap-3 border-t bg-muted/30 px-3 font-mono text-xs text-muted-foreground"
					>
						<div class="flex min-w-0 items-center gap-2">
							{#if view}
								<Badge variant="outline" class="h-4 px-1 text-xs"
									>{view.deployment.environmentSlug}</Badge
								>
								<span class="truncate">{view.deployment.shortId}</span>
								<span class="text-border">·</span>
								<span class="truncate">{view.files.length} files</span>
							{:else}
								<span>No release selected</span>
							{/if}
						</div>
						<div class="flex shrink-0 items-center gap-3">
							{#if activePath}
								<span class="hidden sm:inline">{languageFor(activePath)}</span>
								{#if activeImage}
									<span>{imageSize ? `${imageSize.width}×${imageSize.height}` : 'image'}</span>
								{:else if activeFile}
									<span>{formatBytes(activeFile.size)}</span>
								{/if}
								<span>UTF-8</span>
								{#if cursor.selected > 0}
									<span>{cursor.selected} selected</span>
								{:else}
									<span>Ln {cursor.line}, Col {cursor.column}</span>
								{/if}
							{:else}
								<span class="hidden sm:inline">read-only snapshot</span>
							{/if}
							<span class="flex items-center gap-1">
								<LockIcon class="size-3" /> read-only
							</span>
						</div>
					</div>
				</section>
			</div>
		</div>
	</div>

	<p
		class="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 font-mono text-xs text-muted-foreground"
	>
		<span>{shortcutLabel} quick open</span>
		<span class="text-border">·</span>
		<span>{isMac ? '⌘B' : 'Ctrl B'} explorer</span>
		<span class="text-border">·</span>
		<span>Read-only view of the immutable release artifact</span>
		{#if view}
			<span class="text-border">·</span>
			<span>built {new Date(view.release.createdAt).toUTCString()}</span>
		{/if}
	</p>
</div>

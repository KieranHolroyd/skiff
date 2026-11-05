<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CloudUploadIcon from '@lucide/svelte/icons/cloud-upload';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { formatBytes } from '../../../../_lib/format.js';
	import { fileIcon } from './file-icon.js';
	import type { UploadItem, UploadQueue } from './upload-queue.svelte.js';

	/** Floating progress card for the object browser's upload queue. */
	let { queue }: { queue: UploadQueue } = $props();

	/** Rows rendered at once; a dropped tree can hold thousands of files. */
	const MAX_ROWS = 300;

	let collapsed = $state(false);
	const counts = $derived(queue.counts);
	const live = $derived(queue.items.length - counts.cancelled);
	const finished = $derived(counts.done + counts.failed);
	// Failures first, then work in flight, then what's waiting, then what landed.
	const ordered = $derived.by(() => {
		const rank: Record<UploadItem['status'], number> = {
			failed: 0,
			uploading: 1,
			queued: 2,
			done: 3,
			cancelled: 4
		};
		return [...queue.items].sort((a, b) => rank[a.status] - rank[b.status] || a.id - b.id);
	});
	const rows = $derived(ordered.slice(0, MAX_ROWS));

	const title = $derived(
		queue.running
			? `Uploading ${Math.min(finished + 1, live)} of ${live}`
			: counts.failed > 0
				? `${counts.failed} upload${counts.failed === 1 ? '' : 's'} failed`
				: `Uploaded ${counts.done} item${counts.done === 1 ? '' : 's'}`
	);

	function label(item: UploadItem): string {
		return item.kind === 'folder' ? item.key.replace(/\/$/, '') : item.key;
	}
</script>

{#if queue.items.length > 0}
	<section
		aria-label="Uploads"
		class="fixed right-4 bottom-4 z-40 flex w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg"
	>
		<header class="flex items-center gap-2 border-b px-3 py-2">
			{#if queue.running}
				<CloudUploadIcon class="size-4 shrink-0 text-brand" />
			{:else if counts.failed > 0}
				<CircleAlertIcon class="size-4 shrink-0 text-destructive" />
			{:else}
				<CircleCheckIcon class="size-4 shrink-0 text-success" />
			{/if}
			<div class="min-w-0 flex-1">
				<p class="truncate text-sm font-medium">{title}</p>
				<p class="text-xs text-muted-foreground tabular-nums">
					{formatBytes(queue.loadedBytes)} of {formatBytes(queue.totalBytes)}
					{#if queue.running}· {Math.round(queue.progress * 100)}%{/if}
				</p>
			</div>
			{#if !queue.running && counts.failed > 0}
				<Button size="sm" variant="ghost" onclick={() => queue.retryFailed()}>
					<RotateCcwIcon />Retry
				</Button>
			{/if}
			{#if queue.running}
				<Button size="sm" variant="ghost" onclick={() => queue.cancelAll()}>Cancel all</Button>
			{/if}
			<Button
				size="icon-sm"
				variant="ghost"
				onclick={() => (collapsed = !collapsed)}
				aria-label={collapsed ? 'Show uploads' : 'Hide uploads'}
				aria-expanded={!collapsed}
			>
				<ChevronDownIcon class="transition-transform {collapsed ? 'rotate-180' : ''}" />
			</Button>
			{#if !queue.running}
				<Button size="icon-sm" variant="ghost" onclick={() => queue.clear()} aria-label="Dismiss">
					<XIcon />
				</Button>
			{/if}
		</header>
		{#if queue.running}
			<Progress value={queue.progress * 100} class="h-0.5 rounded-none" />
		{/if}
		{#if !collapsed}
			<ul class="max-h-72 divide-y overflow-y-auto">
				{#each rows as item (item.id)}
					{@const Icon = item.kind === 'folder' ? FolderIcon : fileIcon(item.key)}
					<li
						class="flex items-center gap-2.5 px-3 py-2 {item.status === 'cancelled'
							? 'opacity-50'
							: ''}"
					>
						<Icon
							class="size-4 shrink-0 {item.kind === 'folder'
								? 'text-brand'
								: 'text-muted-foreground'}"
						/>
						<div class="min-w-0 flex-1">
							<p class="truncate font-mono text-xs" title={item.key}>{label(item)}</p>
							{#if item.status === 'uploading' && item.kind === 'file'}
								<Progress value={item.size ? (item.loaded / item.size) * 100 : 0} class="mt-1" />
							{:else if item.status === 'failed'}
								<p class="truncate text-xs text-destructive" title={item.error ?? ''}>
									{item.error}
								</p>
							{:else}
								<p class="text-xs text-muted-foreground">
									{#if item.kind === 'folder'}Folder{:else}{formatBytes(item.size)}{/if}
									{#if item.status === 'queued'}· Waiting{:else if item.status === 'cancelled'}·
										Cancelled{/if}
								</p>
							{/if}
						</div>
						<div class="flex shrink-0 items-center">
							{#if item.status === 'uploading'}
								<Spinner class="size-3.5 text-muted-foreground" />
							{:else if item.status === 'done'}
								<CircleCheckIcon class="size-4 text-success" />
							{/if}
							{#if item.status === 'failed' || item.status === 'cancelled'}
								<Button
									size="icon-sm"
									variant="ghost"
									onclick={() => queue.retry(item)}
									aria-label="Retry {label(item)}"
									title="Retry"
								>
									<RotateCcwIcon />
								</Button>
							{:else if !item.finished}
								<Button
									size="icon-sm"
									variant="ghost"
									onclick={() => queue.cancel(item)}
									aria-label="Cancel {label(item)}"
									title="Cancel"
								>
									<XIcon />
								</Button>
							{/if}
						</div>
					</li>
				{/each}
				{#if ordered.length > rows.length}
					<li class="px-3 py-2 text-center text-xs text-muted-foreground">
						and {ordered.length - rows.length} more
					</li>
				{/if}
			</ul>
		{/if}
	</section>
{/if}

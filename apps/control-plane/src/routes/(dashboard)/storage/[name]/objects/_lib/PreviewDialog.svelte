<script lang="ts">
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import FileWarningIcon from '@lucide/svelte/icons/file-warning';
	import LinkIcon from '@lucide/svelte/icons/link';
	import MusicIcon from '@lucide/svelte/icons/music';
	import type { StorageObject } from '@yoal/contracts';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { previewOf, TEXT_PREVIEW_MAX_BYTES } from '#lib/storage-preview.js';
	import { formatBytes, formatDateTime } from '../../../../_lib/format.js';

	/**
	 * A lightbox for the objects in the current folder: images, video, audio and PDFs render
	 * natively from the inline object endpoint; text is fetched and shown as plain text. Arrow keys
	 * step through every previewable object in the view.
	 */
	let {
		open = $bindable(false),
		index = $bindable(0),
		items,
		name,
		previewHref,
		downloadHref,
		onCopyKey,
		onShare
	}: {
		open?: boolean;
		index?: number;
		items: StorageObject[];
		/** The key shown to the user (the current prefix stripped). */
		name: (key: string) => string;
		previewHref: (object: StorageObject) => string;
		downloadHref: (key: string) => string;
		onCopyKey: (key: string) => void;
		onShare: (key: string) => void;
	} = $props();

	const object = $derived(items[index] ?? null);
	const preview = $derived(object ? previewOf(object.key) : null);
	const src = $derived(object ? previewHref(object) : '');

	// Per-object load state; reset whenever the shown object changes.
	let failed = $state(false);
	let loading = $state(true);
	let text = $state<string | null>(null);

	$effect(() => {
		const current = object;
		const kind = preview?.kind;
		failed = false;
		text = null;
		loading = kind === 'image' || kind === 'text' || kind === 'pdf';
		if (!open || !current || kind !== 'text') return;
		if (current.sizeBytes > TEXT_PREVIEW_MAX_BYTES) {
			loading = false;
			return;
		}
		const controller = new AbortController();
		fetch(downloadHref(current.key), { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) throw new Error(String(response.status));
				const body = await response.text();
				text = body;
			})
			.catch((caught: unknown) => {
				if ((caught as Error)?.name !== 'AbortError') failed = true;
			})
			.finally(() => {
				if (!controller.signal.aborted) loading = false;
			});
		return () => controller.abort();
	});

	const hasPrev = $derived(index > 0);
	const hasNext = $derived(index < items.length - 1);
	const step = (delta: number) => {
		const next = index + delta;
		if (next >= 0 && next < items.length) index = next;
	};

	function onKeydown(event: KeyboardEvent) {
		if (!open) return;
		const target = event.target as HTMLElement | null;
		// Leave arrow keys alone while a media element has focus (they seek/change volume).
		if (target?.closest('video, audio, input, textarea')) return;
		if (event.key === 'ArrowLeft') {
			event.preventDefault();
			step(-1);
		} else if (event.key === 'ArrowRight') {
			event.preventDefault();
			step(1);
		}
	}

	const tooBigForText = $derived(
		preview?.kind === 'text' && !!object && object.sizeBytes > TEXT_PREVIEW_MAX_BYTES
	);
</script>

<svelte:window onkeydown={onKeydown} />

<Dialog.Root bind:open>
	<Dialog.Content class="gap-0 overflow-hidden p-0 sm:max-w-5xl" showCloseButton={false}>
		{#if object && preview}
			<Dialog.Header class="flex-row items-center gap-2 border-b px-4 py-3">
				<div class="min-w-0 flex-1">
					<Dialog.Title class="truncate font-mono text-sm" title={object.key}>
						{name(object.key)}
					</Dialog.Title>
					<Dialog.Description class="text-xs tabular-nums">
						{formatBytes(object.sizeBytes)}{object.lastModified
							? ` · ${formatDateTime(object.lastModified)}`
							: ''}{items.length > 1 ? ` · ${index + 1} of ${items.length}` : ''}
					</Dialog.Description>
				</div>
				<div class="flex shrink-0 items-center gap-0.5">
					<Button
						size="icon-sm"
						variant="ghost"
						onclick={() => onCopyKey(object.key)}
						aria-label="Copy key"
						title="Copy key"
					>
						<CopyIcon />
					</Button>
					<Button
						size="icon-sm"
						variant="ghost"
						onclick={() => onShare(object.key)}
						aria-label="Create share link"
						title="Create share link"
					>
						<LinkIcon />
					</Button>
					{#if preview.kind !== 'text'}
						<Button
							size="icon-sm"
							variant="ghost"
							href={src}
							target="_blank"
							rel="noopener"
							aria-label="Open in a new tab"
							title="Open in a new tab"
							data-sveltekit-reload
						>
							<ExternalLinkIcon />
						</Button>
					{/if}
					<Button
						size="icon-sm"
						variant="ghost"
						href={downloadHref(object.key)}
						aria-label="Download"
						title="Download"
						data-sveltekit-reload
					>
						<DownloadIcon />
					</Button>
					<Dialog.Close>
						{#snippet child({ props })}
							<Button {...props} size="sm" variant="outline" class="ml-1">Close</Button>
						{/snippet}
					</Dialog.Close>
				</div>
			</Dialog.Header>

			<div class="relative flex min-h-64 items-center justify-center bg-muted/40">
				{#if failed}
					{@render unavailable('This object could not be previewed.')}
				{:else if preview.kind === 'image'}
					{#key src}
						<img
							{src}
							alt={name(object.key)}
							class="max-h-[72svh] max-w-full object-contain {loading ? 'opacity-0' : ''}"
							onload={() => (loading = false)}
							onerror={() => {
								loading = false;
								failed = true;
							}}
						/>
					{/key}
				{:else if preview.kind === 'video'}
					{#key src}
						<video
							{src}
							controls
							preload="metadata"
							class="max-h-[72svh] w-full bg-black"
							onerror={() => (failed = true)}
						>
							<!-- Uploaded media has no caption file to offer. -->
							<track kind="captions" />
						</video>
					{/key}
				{:else if preview.kind === 'audio'}
					<div class="flex w-full max-w-md flex-col items-center gap-5 px-6 py-12">
						<div
							class="flex size-20 items-center justify-center rounded-2xl bg-brand/10 text-brand"
						>
							<MusicIcon class="size-9" />
						</div>
						{#key src}
							<audio
								{src}
								controls
								preload="metadata"
								class="w-full"
								onerror={() => (failed = true)}
							></audio>
						{/key}
					</div>
				{:else if preview.kind === 'pdf'}
					{#key src}
						<iframe
							{src}
							title={name(object.key)}
							class="h-[72svh] w-full bg-background"
							onload={() => (loading = false)}
						></iframe>
					{/key}
				{:else if preview.kind === 'text'}
					{#if tooBigForText}
						{@render unavailable(
							`Text previews are limited to ${formatBytes(TEXT_PREVIEW_MAX_BYTES)}; download the file to read it.`
						)}
					{:else if text !== null}
						<pre
							class="max-h-[72svh] w-full overflow-auto bg-background p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{text ||
								'(empty file)'}</pre>
					{/if}
				{/if}

				{#if loading && !failed}
					<div class="absolute inset-0 flex items-center justify-center">
						<Spinner class="size-6 text-muted-foreground" />
					</div>
				{/if}

				{#if hasPrev}
					<Button
						size="icon"
						variant="outline"
						class="absolute top-1/2 left-3 -translate-y-1/2 rounded-full shadow-md"
						onclick={() => step(-1)}
						aria-label="Previous object"
						title="Previous (←)"
					>
						<ChevronLeftIcon />
					</Button>
				{/if}
				{#if hasNext}
					<Button
						size="icon"
						variant="outline"
						class="absolute top-1/2 right-3 -translate-y-1/2 rounded-full shadow-md"
						onclick={() => step(1)}
						aria-label="Next object"
						title="Next (→)"
					>
						<ChevronRightIcon />
					</Button>
				{/if}
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>

{#snippet unavailable(message: string)}
	<div
		class="flex flex-col items-center gap-3 px-6 py-16 text-center text-sm text-muted-foreground"
	>
		<FileWarningIcon class="size-8" />
		<p class="max-w-sm">{message}</p>
		{#if object}
			<Button size="sm" variant="outline" href={downloadHref(object.key)} data-sveltekit-reload>
				<DownloadIcon />Download
			</Button>
		{/if}
	</div>
{/snippet}

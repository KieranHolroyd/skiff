<script lang="ts">
	import DownloadIcon from '@lucide/svelte/icons/download';
	import EraserIcon from '@lucide/svelte/icons/eraser';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import PlayIcon from '@lucide/svelte/icons/play';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import type { LogLevel, ServiceLogEvent, ServiceLogQueryResult } from '@skiff/contracts';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import EmptyState from '../EmptyState.svelte';

	/**
	 * Live container logs for a managed service. The server load supplies the newest page; after
	 * that this component tails `endpoint` every two seconds and owns the list.
	 */
	let {
		endpoint,
		filename,
		canRead,
		initial,
		loadError = null,
		emptyHint
	}: {
		/** JSON tail endpoint; receives `?after=<cursor>&limit=`. */
		endpoint: string;
		filename: string;
		canRead: boolean;
		initial: ServiceLogQueryResult | null;
		loadError?: string | null;
		emptyHint: string;
	} = $props();

	// The server load runs once; the tail owns the mutable list after that.
	// svelte-ignore state_referenced_locally
	let events = $state<ServiceLogEvent[]>(initial?.events ?? []);
	// svelte-ignore state_referenced_locally
	let cursor = $state(initial?.cursor ?? 0);
	let live = $state(true);
	let level = $state<'all' | LogLevel>('all');
	let query = $state('');
	// svelte-ignore state_referenced_locally
	let errorText = $state<string | null>(loadError);
	let viewport = $state<HTMLDivElement | null>(null);
	let pinned = $state(true);
	const MAX_EVENTS = 5000;
	const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

	const filtered = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		return events.filter((event) => {
			if (level !== 'all' && RANK[event.level] < RANK[level]) return false;
			if (needle && !event.message.toLowerCase().includes(needle)) return false;
			return true;
		});
	});

	const counts = $derived.by(() => {
		let warn = 0;
		let error = 0;
		for (const event of events) {
			if (event.level === 'warn') warn += 1;
			if (event.level === 'error') error += 1;
		}
		return { warn, error };
	});

	function clock(ts: number): string {
		const date = new Date(ts);
		if (Number.isNaN(date.getTime())) return '--:--:--';
		return date.toISOString().slice(11, 23);
	}

	const levelTone: Record<LogLevel, string> = {
		error: 'text-destructive',
		warn: 'text-warning',
		info: 'text-info',
		debug: 'text-muted-foreground'
	};

	/** Follow new lines only while the reader is at the bottom. */
	function onscroll() {
		if (!viewport) return;
		pinned = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;
	}

	async function scrollToEnd(): Promise<void> {
		await Promise.resolve();
		if (viewport) viewport.scrollTop = viewport.scrollHeight;
	}

	$effect(() => {
		if (viewport) void scrollToEnd();
	});

	async function poll(): Promise<void> {
		if (!canRead || !live) return;
		try {
			const params = new URLSearchParams({ after: String(cursor), limit: '300' });
			const response = await fetch(`${endpoint}?${params.toString()}`, {
				headers: { accept: 'application/json' }
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as { message?: string };
				throw new Error(body.message ?? `HTTP ${response.status}`);
			}
			const page = (await response.json()) as { events: ServiceLogEvent[]; cursor: number };
			if (page.events.length > 0) {
				events = [...events, ...page.events].slice(-MAX_EVENTS);
				if (pinned) await scrollToEnd();
			}
			if (page.cursor) cursor = page.cursor;
			errorText = null;
		} catch (error) {
			errorText = error instanceof Error ? error.message : 'Could not read logs.';
		}
	}

	$effect(() => {
		if (!canRead) return;
		const timer = setInterval(() => void poll(), 2000);
		return () => clearInterval(timer);
	});

	function download(): void {
		const text = filtered
			.map(
				(event) =>
					`${new Date(event.ts).toISOString()} ${event.level.toUpperCase()} ${event.message}`
			)
			.join('\n');
		const blob = new Blob([`${text}\n`], { type: 'text/plain;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = filename;
		anchor.click();
		URL.revokeObjectURL(url);
	}
</script>

{#if !canRead}
	<EmptyState
		icon={ShieldAlertIcon}
		title="Logs are not visible"
		description="This account does not have the logs:read permission."
	/>
{:else}
	<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
		<div class="flex flex-wrap items-center gap-2 border-b px-3 py-2.5">
			<NativeSelect.Root bind:value={level} class="w-44" aria-label="Minimum level">
				<NativeSelect.Option value="all">All levels</NativeSelect.Option>
				<NativeSelect.Option value="info">Info and above</NativeSelect.Option>
				<NativeSelect.Option value="warn">Warnings and errors</NativeSelect.Option>
				<NativeSelect.Option value="error">Errors only</NativeSelect.Option>
			</NativeSelect.Root>
			<InputGroup.Root class="h-8 max-w-xs min-w-48 flex-1">
				<InputGroup.Input bind:value={query} placeholder="Filter lines" aria-label="Filter lines" />
				<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
				{#if query}
					<InputGroup.Addon align="inline-end">
						<InputGroup.Text class="font-mono text-xs">{filtered.length}</InputGroup.Text>
					</InputGroup.Addon>
				{/if}
			</InputGroup.Root>

			<div class="ml-auto flex flex-wrap items-center gap-1.5">
				{#if counts.error > 0}<Badge variant="destructive">{counts.error} errors</Badge>{/if}
				{#if counts.warn > 0}<Badge variant="warning">{counts.warn} warnings</Badge>{/if}
				<Button
					size="sm"
					variant="ghost"
					onclick={() => (live = !live)}
					aria-pressed={!live}
					title={live ? 'Pause the live tail' : 'Resume the live tail'}
				>
					{#if live}
						<span class="relative flex size-2" aria-hidden="true">
							<span class="absolute size-full animate-ping rounded-full bg-success opacity-60"></span>
							<span class="relative size-2 rounded-full bg-success"></span>
						</span>
						Live
						<PauseIcon class="text-muted-foreground" />
					{:else}
						<PlayIcon />Paused
					{/if}
				</Button>
				<Button
					size="icon-sm"
					variant="ghost"
					onclick={download}
					disabled={filtered.length === 0}
					aria-label="Download the visible lines"
					title="Download"
				>
					<DownloadIcon />
				</Button>
				<Button
					size="icon-sm"
					variant="ghost"
					onclick={() => (events = [])}
					disabled={events.length === 0}
					aria-label="Clear this view"
					title="Clear view"
				>
					<EraserIcon />
				</Button>
			</div>
		</div>

		{#if errorText}
			<div class="border-b px-3 py-2">
				<Notice tone="warning">Live tail failed: {errorText}. Retrying…</Notice>
			</div>
		{/if}

		<div
			bind:this={viewport}
			{onscroll}
			class="h-[min(36rem,calc(100dvh-22rem))] min-h-80 overflow-auto bg-muted/25 py-2 font-mono text-xs leading-relaxed"
			role="log"
			aria-live="off"
		>
			{#if filtered.length === 0}
				<div class="grid h-full place-items-center p-6">
					<EmptyState
						icon={events.length === 0 ? ScrollTextIcon : SearchIcon}
						compact
						title={events.length === 0 ? 'No log lines yet' : 'No lines match this filter'}
						description={events.length === 0
							? emptyHint
							: 'Clear the search or lower the level filter.'}
					/>
				</div>
			{:else}
				{#each filtered as event (event.seq)}
					<div class="flex gap-3 px-3 hover:bg-muted/60">
						<span class="shrink-0 text-muted-foreground tabular-nums select-none">{clock(event.ts)}</span>
						<span class="w-11 shrink-0 font-medium {levelTone[event.level]} select-none">
							{event.level.toUpperCase()}
						</span>
						<span
							class="min-w-0 break-words whitespace-pre-wrap {event.level === 'error'
								? 'text-destructive'
								: event.level === 'debug'
									? 'text-muted-foreground'
									: ''}">{event.message}</span
						>
					</div>
				{/each}
			{/if}
		</div>

		<div
			class="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground"
		>
			<span>
				{events.length.toLocaleString('en-GB')} lines in this view{events.length >= MAX_EVENTS
					? ' (oldest dropped)'
					: ''}
			</span>
			{#if !pinned && filtered.length > 0}
				<Button variant="link" size="sm" class="h-auto p-0 text-xs" onclick={scrollToEnd}>
					Jump to newest
				</Button>
			{/if}
		</div>
	</div>
{/if}

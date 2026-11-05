<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import PlayIcon from '@lucide/svelte/icons/play';
	import SearchIcon from '@lucide/svelte/icons/search';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import type { LogLevel, ServiceLogEvent } from '@skiff/contracts';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import PageHeader from '../../../_lib/PageHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The server load runs once; the tail owns the mutable list after that.
	// svelte-ignore state_referenced_locally
	let events = $state<ServiceLogEvent[]>(data.initial?.events ?? []);
	// svelte-ignore state_referenced_locally
	let cursor = $state(data.initial?.cursor ?? 0);
	let live = $state(true);
	let level = $state<'all' | LogLevel>('all');
	let query = $state('');
	let errorText = $state<string | null>(null);
	let viewport = $state<HTMLDivElement | null>(null);
	const MAX_EVENTS = 5000;

	const filtered = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		return events.filter((event) => {
			if (level !== 'all' && event.level !== level) return false;
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

	function tone(event: ServiceLogEvent): string {
		if (event.level === 'error') return 'text-destructive';
		if (event.level === 'warn') return 'text-amber-600 dark:text-amber-400';
		if (event.level === 'debug') return 'text-muted-foreground';
		return 'text-foreground';
	}

	async function scrollToEnd(): Promise<void> {
		await Promise.resolve();
		if (viewport) viewport.scrollTop = viewport.scrollHeight;
	}

	async function poll(): Promise<void> {
		if (!data.canRead || !live) return;
		try {
			const params = new URLSearchParams({ after: String(cursor), limit: '300' });
			const response = await fetch(
				`/api/v1/storage/${encodeURIComponent(data.storage.name)}/logs?${params.toString()}`,
				{ headers: { accept: 'application/json' } }
			);
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as { message?: string };
				throw new Error(body.message ?? `HTTP ${response.status}`);
			}
			const page = (await response.json()) as {
				events: ServiceLogEvent[];
				cursor: number;
			};
			if (page.events.length > 0) {
				events = [...events, ...page.events].slice(-MAX_EVENTS);
				await scrollToEnd();
			}
			if (page.cursor) cursor = page.cursor;
			errorText = null;
		} catch (error) {
			errorText = error instanceof Error ? error.message : 'Could not read logs.';
		}
	}

	$effect(() => {
		if (!data.canRead) return;
		const timer = setInterval(() => void poll(), 2000);
		return () => clearInterval(timer);
	});

	function download(): void {
		const text = filtered
			.map((event) => `${new Date(event.ts).toISOString()} ${event.level.toUpperCase()} ${event.message}`)
			.join('\n');
		const blob = new Blob([`${text}\n`], { type: 'text/plain;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = `${data.storage.name}-rustfs.log`;
		anchor.click();
		URL.revokeObjectURL(url);
	}
</script>

<svelte:head>
	<title>{data.storage.name} logs · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader eyebrow="Storage" title="{data.storage.name} · Logs" target="page.storage">
		<Button
			variant="outline"
			href={resolve('/(dashboard)/storage/[name]', { name: data.storage.name })}
		>
			<ArrowLeftIcon />
			Instance
		</Button>
	</PageHeader>

	{#if !data.canRead}
		<EmptyState
			icon={SearchIcon}
			title="Logs are not visible"
			description="This account does not have the logs:read permission."
		/>
	{:else}
		<div class="flex flex-wrap items-center gap-2">
			<Badge variant={live ? 'info' : 'outline'}>
				{live ? 'Live' : 'Paused'}
			</Badge>
			{#if counts.error > 0}<Badge variant="destructive">{counts.error} errors</Badge>{/if}
			{#if counts.warn > 0}<Badge variant="warning">{counts.warn} warnings</Badge>{/if}
			<span class="text-xs text-muted-foreground">{events.length} lines retained in this view</span>
			<span class="ml-auto flex flex-wrap items-center gap-2">
				<Button size="sm" variant="outline" onclick={() => (live = !live)}>
					{#if live}<PauseIcon />Pause{:else}<PlayIcon />Resume{/if}
				</Button>
				<Button size="sm" variant="outline" onclick={download} disabled={filtered.length === 0}>
					<DownloadIcon />Download
				</Button>
				<Button size="sm" variant="ghost" onclick={() => (events = [])} disabled={events.length === 0}>
					<TrashIcon />Clear view
				</Button>
			</span>
		</div>

		<div class="flex flex-wrap items-center gap-2">
			<select
				bind:value={level}
				class="h-8 rounded-md border border-input bg-background px-2 text-xs"
				aria-label="Minimum level"
			>
				<option value="all">All levels</option>
				<option value="debug">Debug and above</option>
				<option value="info">Info and above</option>
				<option value="warn">Warnings and errors</option>
				<option value="error">Errors only</option>
			</select>
			<div class="relative min-w-56 flex-1">
				<SearchIcon class="pointer-events-none absolute top-2 left-2 size-3.5 text-muted-foreground" />
				<Input bind:value={query} placeholder="Filter lines" class="h-8 pl-7 text-xs" />
			</div>
		</div>

		{#if errorText}
			<p class="text-xs text-destructive">Live tail failed: {errorText}. Retrying…</p>
		{/if}

		<div
			bind:this={viewport}
			class="h-[32rem] overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed"
		>
			{#if filtered.length === 0}
				<div class="p-6">
					<EmptyState
						icon={SearchIcon}
						title={events.length === 0 ? 'No log lines yet' : 'No lines match this filter'}
						description={events.length === 0
							? 'RustFS writes to the unit journal; the agent drains it every couple of seconds. A fresh instance may take a moment.'
							: 'Clear the search or lower the level filter.'}
					/>
				</div>
			{:else}
				{#each filtered as event (event.seq)}
					<div class="flex gap-2 whitespace-pre-wrap break-words">
						<span class="shrink-0 text-muted-foreground">{clock(event.ts)}</span>
						<span class="w-10 shrink-0 {tone(event)}">{event.level.toUpperCase()}</span>
						<span class="{tone(event)}">{event.message}</span>
					</div>
				{/each}
			{/if}
		</div>
	{/if}
</div>

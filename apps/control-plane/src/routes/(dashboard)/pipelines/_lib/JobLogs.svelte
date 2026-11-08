<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import type { PipelineJobView, PipelineLogLine } from '@skiff/contracts';
	import ArrowDownToLineIcon from '@lucide/svelte/icons/arrow-down-to-line';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { errorText } from '#lib/query.js';
	import { jobLogs, LOG_PAGE } from './api.js';
	import { buildRows, sectionize, type LogRow } from './log-rows.js';
	import StateIcon from './StateIcon.svelte';
	import { elapsed } from './status.js';

	/**
	 * Step-grouped job log. Polls `…/jobs/:job/logs?after=<seq>` every 1.5 s until the job is
	 * complete; past 2,000 rows only the visible ones are rendered.
	 */
	let { repo, runId, job }: { repo: string; runId: string; job: PipelineJobView } = $props();

	const VIRTUAL_AFTER = 2000;
	const POLL_MS = 1500;

	let lines = $state.raw<PipelineLogLine[]>([]);
	let loading = $state(true);
	let done = $state(false);
	let failure = $state<string | null>(null);
	let follow = $state(true);
	let viewport = $state<HTMLDivElement | null>(null);

	const stepToggles = new SvelteMap<number, boolean>();
	const groupToggles = new SvelteMap<string, boolean>();

	// Primitive deriveds so a fresh `job` object from each poll does not restart the tail.
	const jobId = $derived(job.id);
	const attempt = $derived(job.attempt);
	const active = $derived(job.status !== 'completed');

	$effect(() => {
		const id = jobId;
		void attempt;
		const controller = new AbortController();
		untrack(() => {
			lines = [];
			loading = true;
			done = false;
			failure = null;
			follow = true;
			stepToggles.clear();
			groupToggles.clear();
			void tail(id, controller.signal);
		});
		return () => controller.abort();
	});

	async function tail(id: string, signal: AbortSignal) {
		let after = 0;
		while (!signal.aborted) {
			try {
				const page = await jobLogs(repo, runId, id, after, signal);
				if (signal.aborted) return;
				if (page.lines.length > 0) {
					lines = [...lines, ...page.lines];
					after = page.next;
				}
				loading = false;
				failure = null;
				if (page.lines.length >= LOG_PAGE) continue;
				if (page.complete) {
					done = true;
					return;
				}
			} catch (error) {
				if (signal.aborted) return;
				loading = false;
				failure = errorText(error, 'Could not load logs.');
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, POLL_MS);
				signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
			});
		}
	}

	const sections = $derived(sectionize(lines));
	const rows = $derived(
		buildRows(
			job,
			sections,
			(step, hot) => stepToggles.get(step) ?? hot,
			(id) => groupToggles.get(id) ?? false
		)
	);
	const virtual = $derived(rows.length > VIRTUAL_AFTER);

	function toggleStep(row: Extract<LogRow, { kind: 'step' }>) {
		stepToggles.set(row.step, !row.open);
	}
	function toggleGroup(row: Extract<LogRow, { kind: 'group' }>) {
		groupToggles.set(row.id, !row.open);
	}

	const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => viewport,
		estimateSize: () => 20,
		overscan: 30
	});

	// `setOptions` writes the store: never read `$virtualizer` reactively here or the effect loops.
	$effect(() => {
		const list = rows;
		const on = virtual;
		const element = viewport;
		untrack(() =>
			$virtualizer.setOptions({
				count: on ? list.length : 0,
				getScrollElement: () => element,
				estimateSize: (index) => (list[index]?.kind === 'step' ? 32 : 20),
				getItemKey: (index) => list[index]?.key ?? index
			})
		);
	});

	$effect(() => {
		const size = rows.length;
		if (!follow || !active || !viewport || size === 0) return;
		void tick().then(() => untrack(() => scrollToEnd()));
	});

	function scrollToEnd() {
		if (!viewport) return;
		if (virtual) $virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
		else viewport.scrollTop = viewport.scrollHeight;
	}

	function onscroll() {
		if (!viewport) return;
		follow = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48;
	}

	const levelClass: Record<string, string> = {
		error: 'bg-destructive/10 text-destructive',
		warning: 'bg-warning/10 text-warning',
		notice: 'text-info',
		debug: 'text-muted-foreground'
	};
</script>

<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
	<div
		bind:this={viewport}
		{onscroll}
		class="relative overflow-auto overscroll-contain bg-muted/30 py-1 font-mono text-xs {virtual
			? 'h-[70vh]'
			: 'max-h-[70vh]'}"
		role="log"
		aria-live="polite"
		aria-label="Log output for {job.name}"
	>
		{#if loading && lines.length === 0 && job.steps.length === 0}
			<div class="flex items-center gap-2 px-4 py-6 text-muted-foreground">
				<Spinner /> Loading logs…
			</div>
		{:else if rows.length === 0}
			<p class="px-4 py-6 text-muted-foreground">
				{failure ? 'No log lines could be loaded.' : active ? 'Waiting for output…' : 'No output.'}
			</p>
		{:else if virtual}
			<div class="relative w-full" style="height: {$virtualizer.getTotalSize()}px">
				{#each $virtualizer.getVirtualItems() as item (item.key)}
					{@const row = rows[item.index]!}
					<div
						data-index={item.index}
						{@attach (node) => untrack(() => $virtualizer.measureElement(node))}
						class="absolute top-0 left-0 w-full"
						style="transform: translateY({item.start}px)"
					>
						{@render rowView(row)}
					</div>
				{/each}
			</div>
		{:else}
			{#each rows as row (row.key)}
				{@render rowView(row)}
			{/each}
		{/if}
	</div>
	<div
		class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 font-mono text-xs text-muted-foreground"
	>
		{#if failure}
			<span class="text-destructive">{failure}</span>
		{:else if done}
			<span>Complete</span>
		{:else}
			<span class="inline-flex items-center gap-1.5"
				><span class="size-1.5 animate-pulse rounded-full bg-info"></span>Live</span
			>
		{/if}
		<span>{lines.length.toLocaleString('en-GB')} lines</span>
		{#if !follow && active}
			<Button
				variant="ghost"
				size="xs"
				class="ml-auto"
				onclick={() => {
					follow = true;
					scrollToEnd();
				}}
			>
				<ArrowDownToLineIcon />Follow
			</Button>
		{/if}
	</div>
</div>

{#snippet rowView(row: LogRow)}
	{#if row.kind === 'step'}
		<button
			type="button"
			class="flex h-8 w-full items-center gap-2 px-3 text-left font-sans text-sm hover:bg-muted"
			aria-expanded={row.open}
			onclick={() => toggleStep(row)}
		>
			<ChevronRightIcon
				class="size-3.5 shrink-0 text-muted-foreground transition-transform {row.open
					? 'rotate-90'
					: ''}"
			/>
			<StateIcon status={row.status} conclusion={row.conclusion} class="size-3.5" />
			<span class="min-w-0 flex-1 truncate">{row.name}</span>
			<span class="font-mono text-xs text-muted-foreground tabular-nums">
				{row.startedAt ? elapsed(row.startedAt, row.finishedAt) : ''}
			</span>
		</button>
	{:else if row.kind === 'group'}
		<button
			type="button"
			class="flex min-h-5 w-full items-center gap-1 py-px pr-3 pl-[3.25rem] text-left hover:bg-muted"
			aria-expanded={row.open}
			onclick={() => toggleGroup(row)}
		>
			<ChevronRightIcon
				class="size-3 shrink-0 text-muted-foreground transition-transform {row.open ? 'rotate-90' : ''}"
			/>
			<span class="truncate">{row.title}</span>
			<span class="text-muted-foreground">({row.count})</span>
		</button>
	{:else if row.kind === 'empty'}
		<p class="py-1 pr-3 pl-[3.25rem] text-muted-foreground">{row.text}</p>
	{:else}
		<div class="flex min-h-5 py-px pr-3 {row.level ? levelClass[row.level] : ''}">
			<span class="w-12 shrink-0 pr-3 text-right text-muted-foreground/70 tabular-nums select-none"
				>{row.n}</span
			>
			<span
				class="min-w-0 flex-1 break-all whitespace-pre-wrap {row.nested ? 'pl-4' : ''} {row.stream ===
				'system'
					? 'text-muted-foreground'
					: ''}">{#if row.level === 'error'}<span class="font-semibold">Error: </span
					>{:else if row.level === 'warning'}<span class="font-semibold">Warning: </span
					>{/if}{row.text}</span
			>
		</div>
	{/if}
{/snippet}

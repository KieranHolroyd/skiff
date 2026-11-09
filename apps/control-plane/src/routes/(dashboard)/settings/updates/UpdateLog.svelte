<script lang="ts">
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import type { SelfUpdateLog, SelfUpdateLogLevel } from '@yoal/contracts';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDateTime } from '../../_lib/format.js';

	let {
		log,
		running = false,
		defaultOpen = true
	}: {
		log: SelfUpdateLog;
		running?: boolean;
		/** A finished run's log starts folded unless it explains a failure. */
		defaultOpen?: boolean;
	} = $props();

	let toggled = $state<boolean | null>(null);
	const open = $derived(running || (toggled ?? defaultOpen));
	const lastLine = $derived(log.lines.at(-1) ?? null);

	let scroller = $state<HTMLDivElement | null>(null);
	/** Follow the tail until the reader scrolls up; then leave them where they are. */
	let pinned = $state(true);

	const lines = $derived(log.lines);
	const text = $derived(
		lines.map((line) => `${line.at} ${line.level.padEnd(7)} ${line.text}`).join('\n')
	);

	const levelClass: Record<SelfUpdateLogLevel, string> = {
		info: 'text-sidebar-foreground/90',
		phase: 'text-brand',
		command: 'text-muted-foreground',
		output: 'text-sidebar-foreground/70',
		warn: 'text-warning',
		error: 'text-destructive'
	};

	$effect(() => {
		const count = lines.length;
		const element = scroller;
		if (!element || !pinned || (count === 0 && !running)) return;
		element.scrollTop = element.scrollHeight;
	});

	function onscroll() {
		const element = scroller;
		if (!element) return;
		pinned = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
	}

	function jumpToLatest() {
		pinned = true;
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
	}
</script>

<Panel
	title={running ? 'Live log' : 'Update log'}
	icon={TerminalIcon}
	count={lines.length || undefined}
	description={running
		? 'Streamed from the updater. This page reconnects by itself when the control plane restarts.'
		: log.updatedAt
			? `Last written ${formatDateTime(log.updatedAt)}.`
			: undefined}
>
	{#snippet actions()}
		{#if running}
			<span class="flex items-center gap-1.5 text-xs font-medium text-success">
				<span class="relative flex size-1.5">
					<span class="absolute size-full animate-ping rounded-full bg-success opacity-60"></span>
					<span class="relative size-1.5 rounded-full bg-success"></span>
				</span>
				Live
			</span>
		{/if}
		<CopyButton value={text} label="Copy log" />
		{#if !running}
			<Button
				type="button"
				variant="ghost"
				size="sm"
				aria-expanded={open}
				aria-controls="update-log-body"
				onclick={() => (toggled = !open)}
			>
				{open ? 'Hide' : 'Show'}
				<ChevronDownIcon class="transition-transform {open ? 'rotate-180' : ''}" />
			</Button>
		{/if}
	{/snippet}

	{#if !open}
		<button
			type="button"
			class="flex w-full items-center gap-3 rounded-lg border border-sidebar-border bg-sidebar px-3 py-2 text-left font-mono text-xs text-sidebar-foreground/70 transition-colors hover:text-sidebar-foreground"
			onclick={() => (toggled = true)}
		>
			{#if lastLine}
				<span class="shrink-0 text-muted-foreground/60 tabular-nums"
					>{lastLine.at.slice(11, 19)}</span
				>
				<span class="min-w-0 flex-1 truncate {levelClass[lastLine.level]}">{lastLine.text}</span>
			{:else}
				<span class="text-muted-foreground">The updater did not write a log for this run.</span>
			{/if}
		</button>
	{:else}
		<div class="relative" id="update-log-body">
			<div
				bind:this={scroller}
				{onscroll}
				role="log"
				aria-label="Self-update log"
				aria-live="off"
				class="max-h-[22rem] min-h-24 overflow-auto rounded-lg border border-sidebar-border bg-sidebar p-3 font-mono text-xs leading-relaxed text-sidebar-foreground"
			>
				{#if lines.length === 0}
					<p class="text-muted-foreground">
						{running
							? 'Waiting for the updater to write its first line…'
							: 'The updater did not write a log for this run.'}
					</p>
				{:else}
					{#each lines as line, index (index)}
						<div class="flex gap-3">
							<span class="shrink-0 text-muted-foreground/60 tabular-nums select-none"
								>{line.at.slice(11, 19)}</span
							>
							<span class="min-w-0 break-words whitespace-pre-wrap {levelClass[line.level]}"
								>{line.text}</span
							>
						</div>
					{/each}
				{/if}
			</div>
			{#if !pinned && lines.length > 0}
				<Button
					type="button"
					variant="secondary"
					size="xs"
					class="absolute right-3 bottom-3 shadow-xs"
					onclick={jumpToLatest}
				>
					<ArrowDownIcon />
					Latest
				</Button>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		{#if log.truncated}
			Showing the newest {lines.length} lines; the full output is in
			<code>journalctl -u yoal-update-self</code>.{/if}
		{running ? 'Times are UTC. The update keeps running if you close this page.' : 'Times are UTC.'}
	{/snippet}
</Panel>

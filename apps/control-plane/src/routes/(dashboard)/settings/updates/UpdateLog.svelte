<script lang="ts">
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import type { SelfUpdateLog, SelfUpdateLogLevel } from '@skiff/contracts';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDateTime } from '../../_lib/format.js';

	let {
		log,
		running = false
	}: {
		log: SelfUpdateLog;
		running?: boolean;
	} = $props();

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
		command: 'text-sidebar-muted',
		output: 'text-sidebar-foreground/70',
		warn: 'text-warning',
		error: 'text-danger'
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
			<span class="flex items-center gap-1.5 text-[11px] font-medium text-success-soft-foreground">
				<span class="relative flex size-1.5">
					<span class="absolute size-full animate-ping rounded-full bg-success opacity-60"></span>
					<span class="relative size-1.5 rounded-full bg-success"></span>
				</span>
				Live
			</span>
		{/if}
		<CopyButton value={text} label="Copy log" />
	{/snippet}

	<div class="relative">
		<div
			bind:this={scroller}
			{onscroll}
			role="log"
			aria-label="Self-update log"
			aria-live="off"
			class="max-h-[22rem] min-h-24 overflow-auto rounded-lg border border-sidebar-border bg-sidebar p-3 font-mono text-[11.5px] leading-relaxed text-sidebar-foreground"
		>
			{#if lines.length === 0}
				<p class="text-sidebar-muted">
					{running
						? 'Waiting for the updater to write its first line…'
						: 'The updater did not write a log for this run.'}
				</p>
			{:else}
				{#each lines as line, index (index)}
					<div class="flex gap-3">
						<span class="shrink-0 text-sidebar-muted/60 tabular-nums select-none"
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
				class="absolute right-3 bottom-3 shadow-card"
				onclick={jumpToLatest}
			>
				<ArrowDownIcon />
				Latest
			</Button>
		{/if}
	</div>

	{#snippet footer()}
		{#if log.truncated}
			Showing the newest {lines.length} lines; the full output is in
			<code>journalctl -u skiff-update-self</code>.{/if}
		Times are UTC.{#if running}
			The update keeps running if you close this page.{/if}
	{/snippet}
</Panel>

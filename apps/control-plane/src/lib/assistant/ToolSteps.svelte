<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleMinusIcon from '@lucide/svelte/icons/circle-minus';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import type { ToolStep } from '#lib/assistant/assistant.svelte.js';
	import { formatDuration } from '#lib/assistant/format.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';

	/**
	 * The tool calls the assistant made in a turn: a compact summary line that expands into one row
	 * per call, each with its arguments, result excerpt and timing.
	 */
	let { steps, live = false }: { steps: ToolStep[]; live?: boolean } = $props();

	let open = $state<boolean | null>(null);
	let expanded = $state<Record<string, boolean>>({});

	const running = $derived(steps.filter((step) => step.status === 'running').length);
	const failed = $derived(steps.filter((step) => step.status === 'error').length);
	// Open while the assistant is working, collapse once it finishes, unless the user chose.
	const isOpen = $derived(open ?? (live && running > 0));
	const current = $derived(steps.findLast((step) => step.status === 'running'));
</script>

<div class="rounded-lg border bg-muted/30 text-xs">
	<button
		type="button"
		class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-muted-foreground hover:text-foreground"
		onclick={() => (open = !isOpen)}
		aria-expanded={isOpen}
	>
		<ChevronRightIcon class="size-3.5 shrink-0 transition-transform {isOpen ? 'rotate-90' : ''}" />
		{#if running > 0}
			<Spinner class="size-3" />
			<span class="truncate">{current?.title ?? 'Working'}…</span>
		{:else}
			<WrenchIcon class="size-3.5 shrink-0" />
			<span>
				{steps.length}
				{steps.length === 1 ? 'step' : 'steps'}
				{#if failed > 0}<span class="text-destructive">· {failed} failed</span>{/if}
			</span>
		{/if}
	</button>
	{#if isOpen}
		<ul class="space-y-0.5 border-t px-1.5 py-1.5">
			{#each steps as step (step.callId)}
				{@const hasMore = Boolean(step.args || step.detail)}
				<li>
					<button
						type="button"
						class="flex w-full items-start gap-2 rounded-md px-1 py-1 text-left {hasMore
							? 'hover:bg-muted'
							: 'cursor-default'}"
						onclick={() => hasMore && (expanded[step.callId] = !expanded[step.callId])}
					>
						<span class="mt-px shrink-0">
							{#if step.status === 'running'}
								<Spinner class="size-3.5" />
							{:else if step.status === 'ok'}
								<CircleCheckIcon class="size-3.5 text-success" />
							{:else if step.status === 'error'}
								<CircleXIcon class="size-3.5 text-destructive" />
							{:else}
								<CircleMinusIcon class="size-3.5 text-muted-foreground" />
							{/if}
						</span>
						<span class="min-w-0 flex-1">
							<span class="flex items-baseline gap-2">
								<span class="truncate font-medium">{step.title}</span>
								<span class="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
									{step.durationMs !== undefined ? formatDuration(step.durationMs) : ''}
								</span>
							</span>
							{#if step.summary && !expanded[step.callId]}
								<span class="line-clamp-1 text-muted-foreground">{step.summary}</span>
							{/if}
						</span>
					</button>
					{#if expanded[step.callId]}
						<div class="mt-0.5 mb-1 ml-6 space-y-1.5">
							<p class="font-mono text-[10px] text-muted-foreground">{step.tool}</p>
							{#if step.args}
								<pre
									class="max-h-28 overflow-auto rounded bg-muted p-1.5 font-mono text-[11px] break-all whitespace-pre-wrap">{step.args}</pre>
							{/if}
							{#if step.detail}
								<pre
									class="max-h-56 overflow-auto rounded bg-muted p-1.5 font-mono text-[11px] break-words whitespace-pre-wrap">{step.detail}</pre>
							{/if}
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<script lang="ts">
	import type { AppErrorExceptionView } from '@yoal/contracts';
	import { SvelteSet } from 'svelte/reactivity';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { frameLocation, frameRuns, stackText } from './issue-ui.js';

	/**
	 * The exception chain of one event, crash frame first. Library frames fold into a single row per
	 * run so the reader's own code is what they see; "Full stack" opens every fold at once.
	 */
	let { exceptions }: { exceptions: AppErrorExceptionView[] } = $props();

	let full = $state(false);
	const opened = new SvelteSet<string>();
	const hasLibrary = $derived(
		exceptions.some((exception) => exception.frames.some((frame) => !frame.inApp))
	);
	const hasApp = $derived(
		exceptions.some((exception) => exception.frames.some((frame) => frame.inApp))
	);
</script>

<div class="space-y-3">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h3 class="flex items-center gap-2 text-sm font-medium">
			<LayersIcon class="size-4 text-muted-foreground" />Stack trace
		</h3>
		<div class="flex items-center gap-3">
			{#if hasLibrary && hasApp}
				<label class="flex items-center gap-2 text-xs text-muted-foreground">
					<Switch bind:checked={full} size="sm" aria-label="Show library frames" />Full stack
				</label>
			{/if}
			<CopyButton value={stackText(exceptions)} label="Copy stack" size="xs" variant="ghost" />
		</div>
	</div>

	{#each exceptions as exception, exceptionIndex (exceptionIndex)}
		<div class="overflow-hidden rounded-lg border">
			<div class="border-b bg-muted/40 px-3 py-2">
				{#if exceptionIndex > 0}
					<p class="mb-0.5 text-[11px] text-muted-foreground uppercase">Caused by</p>
				{/if}
				<p class="text-sm break-words">
					<span class="font-semibold">{exception.type}</span>{#if exception.value}<span
							class="text-muted-foreground">: {exception.value}</span
						>{/if}
				</p>
			</div>
			{#if exception.frames.length === 0}
				<p class="px-3 py-2 text-xs text-muted-foreground">
					The SDK sent no stack frames for this exception.
				</p>
			{:else}
				<ol class="divide-y font-mono text-xs">
					{#each frameRuns(exception.frames) as run, runIndex (runIndex)}
						{#if run.kind === 'app'}
							<li
								class="flex flex-wrap gap-x-3 gap-y-0.5 px-3 py-1.5 {run.frame.inApp
									? 'bg-card'
									: 'text-muted-foreground'}"
							>
								<span
									class="min-w-0 font-medium break-all {run.frame.inApp ? 'text-foreground' : ''}"
								>
									{run.frame.fn || '<anonymous>'}
								</span>
								<span class="ms-auto min-w-0 break-all text-muted-foreground"
									>{frameLocation(run.frame)}</span
								>
							</li>
						{:else}
							{@const key = `${exceptionIndex}:${run.start}`}
							{@const open = full || opened.has(key)}
							<li class="bg-muted/20 text-muted-foreground">
								<button
									type="button"
									class="flex w-full items-center gap-1.5 px-3 py-1 text-left font-sans hover:bg-muted/50"
									aria-expanded={open}
									onclick={() => (opened.has(key) ? opened.delete(key) : opened.add(key))}
									disabled={full}
								>
									<ChevronRightIcon
										class="size-3.5 transition-transform {open ? 'rotate-90' : ''}"
									/>
									{run.frames.length} library frame{run.frames.length === 1 ? '' : 's'}
								</button>
								{#if open}
									<ol class="divide-y border-t border-dashed">
										{#each run.frames as frame, frameIndex (frameIndex)}
											<li class="flex flex-wrap gap-x-3 gap-y-0.5 py-1.5 pr-3 pl-8">
												<span class="min-w-0 break-all">{frame.fn || '<anonymous>'}</span>
												<span class="ms-auto min-w-0 break-all">{frameLocation(frame)}</span>
											</li>
										{/each}
									</ol>
								{/if}
							</li>
						{/if}
					{/each}
				</ol>
			{/if}
		</div>
	{/each}
</div>

<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import type { BulkRun } from './bulk.svelte.js';

	/** Replaces the bulk bar while an action applies. */
	let { run, href }: { run: BulkRun; href: string } = $props();

	const operation = $derived(run.operation);
	const total = $derived(Math.max(operation.total, 1));
	const title = $derived(
		operation.status === 'applying' ? run.info.label : `${run.info.label}: starting`
	);
</script>

<div
	class="sticky bottom-4 z-20 mx-auto w-full max-w-md space-y-2 rounded-xl border bg-popover px-4 py-3 text-sm shadow-lg"
	role="status"
	aria-live="polite"
>
	<div class="flex items-center justify-between gap-3">
		<span class="flex items-center gap-2 font-medium"><Spinner />{title}</span>
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the caller passes a resolved href -->
		<a {href} class="text-xs text-muted-foreground underline-offset-4 hover:underline">Details</a>
	</div>
	<Progress value={operation.done} max={total} aria-label="Progress" />
	<div class="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
		<span>{operation.done} / {operation.total} done</span>
		{#if operation.failed}<span class="text-destructive">{operation.failed} failed</span>{/if}
	</div>
	{#if run.failures.length}
		<Collapsible.Root>
			<Collapsible.Trigger
				class="group inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
			>
				<ChevronRightIcon class="size-3 transition-transform group-data-[state=open]:rotate-90" />
				Show failures
			</Collapsible.Trigger>
			<Collapsible.Content>
				<ul class="mt-1.5 max-h-40 space-y-1 overflow-y-auto text-xs">
					{#each run.failures as item (item.seq)}
						<li>
							<span class="font-mono">{item.label ?? item.targetId}</span>
							<span class="text-muted-foreground">— {item.error ?? 'Unknown error'}</span>
						</li>
					{/each}
				</ul>
			</Collapsible.Content>
		</Collapsible.Root>
	{/if}
</div>

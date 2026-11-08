<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import CheckIcon from '@lucide/svelte/icons/check';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import type { ReverseDnsCheck, ReverseDnsState } from './setup-guide.js';

	/**
	 * The live forward-confirmed reverse DNS check (EMAIL.md §3.3, preflight check 3). The loader
	 * streams the lookup, so the page renders first and this fills in when DNS answers. Shared by
	 * the overview's checklist and Email → Mail server.
	 */
	let {
		check,
		ip,
		onresult
	}: {
		check: Promise<ReverseDnsCheck> | null;
		ip: string;
		/** Reports the finished state, so the checklist can mark its step. */
		onresult?: (state: ReverseDnsState | null) => void;
	} = $props();

	let result = $state<ReverseDnsCheck | null>(null);
	let checking = $state(false);
	$effect(() => {
		const pending = check;
		result = null;
		onresult?.(null);
		if (!pending) return;
		checking = true;
		let current = true;
		pending
			.then((value) => {
				if (!current) return;
				result = value;
				onresult?.(value.state);
			})
			.finally(() => {
				if (current) checking = false;
			});
		return () => {
			current = false;
		};
	});

	const COPY: Record<ReverseDnsState, { tone: 'success' | 'warning' | 'danger'; text: string }> = {
		ok: { tone: 'success', text: 'Reverse DNS checks out in both directions.' },
		missing: { tone: 'danger', text: 'No PTR record found for this IP yet.' },
		mismatch: {
			tone: 'warning',
			text: "The PTR record or the A record doesn't match yet. Both must name each other."
		},
		unknown: {
			tone: 'warning',
			text: "Couldn't complete the DNS lookups from the control plane. Try again in a minute."
		}
	};
</script>

<div class="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-3 py-2.5 text-sm">
	{#if checking || !result}
		<Spinner />
		<span class="text-muted-foreground">Looking up {ip}…</span>
	{:else}
		{@const copy = COPY[result.state]}
		{#if result.state === 'ok'}
			<CheckIcon class="size-4 text-success" />
		{:else}
			<XIcon class="size-4 {copy.tone === 'danger' ? 'text-destructive' : 'text-warning'}" />
		{/if}
		<span class="flex-1">
			{copy.text}
			{#if result.ptr.length > 0 && result.state !== 'ok'}
				<span class="text-muted-foreground">
					PTR returns <span class="font-mono text-xs">{result.ptr.join(', ')}</span>.
				</span>
			{/if}
		</span>
		<Button variant="outline" size="sm" onclick={() => invalidateAll()}
			><RefreshCwIcon />Check again</Button
		>
	{/if}
</div>

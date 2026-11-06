<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import type { DatabaseStudioPrincipalState } from '@skiff/contracts';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';

	/**
	 * A read-only session waits for the database's own read-only account (plan 22 track G). While
	 * the node creates it, poll the page data; a failure shows the node's error and a retry, which
	 * opens the session again and so starts a new attempt.
	 */
	let {
		nodeLabel,
		// Aliased: a prop named `state` would shadow the `$state` rune.
		state: principalState,
		error,
		onretry
	}: {
		nodeLabel: string;
		state: Exclude<DatabaseStudioPrincipalState, 'ready'>;
		error: string | null;
		onretry: () => void;
	} = $props();

	/** The node confirms within one agent loop and heartbeat, usually under 20 s. */
	const POLL_MS = 2_000;

	/**
	 * Past this the node is not just slow: it may be offline, or the database stopped (tasks only
	 * go to running databases). An agent too old for the task is reported as a failure instead.
	 */
	const STALL_MS = 45_000;
	let stalled = $state(false);

	$effect(() => {
		if (principalState !== 'preparing') return;
		stalled = false;
		const timer = setInterval(() => void invalidateAll(), POLL_MS);
		const stall = setTimeout(() => (stalled = true), STALL_MS);
		return () => {
			clearInterval(timer);
			clearTimeout(stall);
		};
	});
</script>

{#if principalState === 'preparing'}
	<div class="flex items-start gap-2 py-10 text-sm text-muted-foreground" role="status">
		<Spinner class="mt-0.5 size-4" />
		<div class="space-y-1">
			<p class="font-medium text-foreground">Preparing read-only access</p>
			<p>{nodeLabel} is creating this database's read-only account. The studio connects as soon as it's ready.</p>
			{#if stalled}
				<p>
					This is taking longer than usual. Check that {nodeLabel} is online and the database is running; the
					account is created as soon as both are true.
				</p>
			{/if}
		</div>
	</div>
{:else}
	<Notice tone="danger" title="Read-only access could not be prepared">
		<p>{error ?? 'The node could not create the read-only account.'}</p>
		<div class="mt-2 flex gap-2">
			<Button size="sm" variant="outline" onclick={onretry}><RefreshCwIcon />Try again</Button>
		</div>
	</Notice>
{/if}

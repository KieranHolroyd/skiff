<script lang="ts">
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { getStudioShell } from './context.js';
	import { describeStudioError } from './errors.js';

	/**
	 * A studio failure explained by its error code: an expired session offers to reopen, a
	 * read-only refusal points at "Enable writes", anything else can be retried.
	 */
	let {
		error,
		onretry,
		class: className = ''
	}: { error: unknown; onretry?: () => void; class?: string } = $props();

	const shell = getStudioShell();
	const info = $derived(describeStudioError(error));
</script>

<Notice tone={info.code === 'read_only' || info.code === 'conflict' ? 'warning' : 'danger'} title={info.title} class={className}>
	<p>{info.message}</p>
	{#if (info.reopen && shell) || onretry}
		<div class="mt-2 flex gap-2">
			{#if info.reopen && shell}
				<Button size="sm" onclick={() => shell.reopen()}><RefreshCwIcon />Open again</Button>
			{:else if onretry}
				<Button size="sm" variant="outline" onclick={onretry}><RefreshCwIcon />Try again</Button>
			{/if}
		</div>
	{/if}
</Notice>

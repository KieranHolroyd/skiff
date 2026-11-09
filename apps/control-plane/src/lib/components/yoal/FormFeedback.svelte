<script lang="ts">
	import Notice from './Notice.svelte';

	/** Renders the standard `{ success, message }` shape returned by dashboard form actions. */
	let { result }: { result: { success?: string; message?: string } | null | undefined } = $props();
</script>

{#if result?.success}
	<Notice tone="success">{result.success}</Notice>
{/if}
{#if result?.message}
	<Notice tone="danger">{result.message}</Notice>
{/if}

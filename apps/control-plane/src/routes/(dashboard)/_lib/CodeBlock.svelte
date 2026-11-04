<script lang="ts">
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';

	/** A copyable shell/config snippet with an optional filename or context label. */
	let {
		code,
		label,
		class: className = ''
	}: {
		code: string;
		label?: string;
		class?: string;
	} = $props();
</script>

<div class="overflow-hidden rounded-md border bg-muted/50 {className}">
	<div class="flex items-center justify-between gap-2 border-b bg-muted px-3 py-1.5">
		<span class="truncate font-mono text-xs text-muted-foreground">{label ?? 'shell'}</span>
		<CopyButton value={code} label="Copy" variant="ghost" size="xs" />
	</div>
	<pre class="overflow-x-auto p-3 font-mono text-xs leading-relaxed"><code>{code}</code></pre>
</div>

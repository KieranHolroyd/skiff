<script lang="ts">
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import HighlightedCode from '#lib/highlight/HighlightedCode.svelte';
	import { resolveLang } from '#lib/highlight/highlight.js';

	/**
	 * A copyable, syntax-highlighted snippet with an optional filename or context label. The
	 * language comes from `lang`, else the label's file extension (`src/index.ts`, `wg0.conf`),
	 * else shell, which is what label-less and context-only labels ("edge", "worker") hold.
	 */
	let {
		code,
		label,
		lang,
		class: className = ''
	}: {
		code: string;
		label?: string;
		lang?: string;
		class?: string;
	} = $props();
</script>

<div class="overflow-hidden rounded-md border bg-muted/50 {className}">
	<div class="flex items-center justify-between gap-2 border-b bg-muted px-3 py-1.5">
		<span class="truncate font-mono text-xs text-muted-foreground">{label ?? 'shell'}</span>
		<CopyButton value={code} label="Copy" variant="ghost" size="xs" />
	</div>
	<HighlightedCode
		{code}
		lang={lang ?? resolveLang(label) ?? 'shell'}
		class="overflow-x-auto p-3 font-mono text-xs leading-relaxed"
	/>
</div>

<script lang="ts">
	import { isLive, statusTone } from '#lib/status.js';

	let { status, class: className = '' }: { status: string; class?: string } = $props();

	const dot: Record<string, string> = {
		success: 'bg-success',
		warning: 'bg-warning',
		danger: 'bg-danger',
		info: 'bg-info',
		brand: 'bg-brand',
		neutral: 'bg-muted-foreground/50'
	};
	const color = $derived(dot[statusTone(status)]);
</script>

<span
	class="relative inline-grid size-2 shrink-0 place-items-center {className}"
	aria-hidden="true"
>
	{#if isLive(status)}
		<span class="absolute inline-flex size-full animate-ping rounded-full opacity-50 {color}"
		></span>
	{/if}
	<span class="relative size-2 rounded-full ring-2 ring-card {color}"></span>
</span>

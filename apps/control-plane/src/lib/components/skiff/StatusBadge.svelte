<script lang="ts">
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { isLive, statusTone, type Tone } from '#lib/status.js';

	let {
		status,
		label,
		tone,
		class: className = ''
	}: { status: string; label?: string; tone?: Tone; class?: string } = $props();

	const resolved = $derived(tone ?? statusTone(status));
	const text = $derived((label ?? status).charAt(0).toUpperCase() + (label ?? status).slice(1));
	const dots: Record<Tone, string> = {
		success: 'bg-success',
		warning: 'bg-warning',
		danger: 'bg-danger',
		info: 'bg-info',
		brand: 'bg-brand',
		neutral: 'bg-muted-foreground/60'
	};
</script>

<Badge variant={resolved} class={className}>
	<span class="relative grid size-1.5 place-items-center" aria-hidden="true">
		{#if isLive(status)}
			<span class="absolute size-full animate-ping rounded-full opacity-60 {dots[resolved]}"></span>
		{/if}
		<span class="relative size-1.5 rounded-full {dots[resolved]}"></span>
	</span>
	{text}
</Badge>

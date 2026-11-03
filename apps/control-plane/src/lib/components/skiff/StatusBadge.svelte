<script lang="ts">
	import { isLive, statusTone, type Tone } from '#lib/status.js';

	let {
		status,
		label,
		tone,
		class: className = ''
	}: { status: string; label?: string; tone?: Tone; class?: string } = $props();

	const resolved = $derived(tone ?? statusTone(status));
	const live = $derived(isLive(status));
	const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

	const styles: Record<Tone, { pill: string; dot: string }> = {
		success: { pill: 'bg-success-soft text-success-soft-foreground', dot: 'bg-success' },
		warning: { pill: 'bg-warning-soft text-warning-soft-foreground', dot: 'bg-warning' },
		danger: { pill: 'bg-danger-soft text-danger-soft-foreground', dot: 'bg-danger' },
		info: { pill: 'bg-info-soft text-info-soft-foreground', dot: 'bg-info' },
		brand: { pill: 'bg-brand-soft text-brand-soft-foreground', dot: 'bg-brand' },
		neutral: { pill: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground/60' }
	};
</script>

<span
	class="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap {styles[
		resolved
	].pill} {className}"
>
	<span class="relative grid size-1.5 place-items-center" aria-hidden="true">
		{#if live}
			<span
				class="absolute inline-flex size-full animate-ping rounded-full opacity-60 {styles[resolved]
					.dot}"
			></span>
		{/if}
		<span class="relative size-1.5 rounded-full {styles[resolved].dot}"></span>
	</span>
	{sentence(label ?? status)}
</span>

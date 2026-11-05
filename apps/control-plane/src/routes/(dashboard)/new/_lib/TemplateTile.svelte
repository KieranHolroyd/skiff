<script lang="ts">
	import { templateIcon } from './icons.js';

	/** A template's icon on a soft tile whose hue is stable per template. */
	let {
		id,
		icon,
		size = 'md',
		class: className = ''
	}: { id: string; icon: string; size?: 'sm' | 'md' | 'lg'; class?: string } = $props();

	const Icon = $derived(templateIcon(icon));
	const hue = $derived.by(() => {
		let hash = 0;
		for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
		return hash;
	});
	const sizes = {
		sm: 'size-8 rounded-lg [&_svg]:size-4',
		md: 'size-11 rounded-xl [&_svg]:size-5',
		lg: 'size-14 rounded-2xl [&_svg]:size-7'
	};
</script>

<div
	class="relative flex shrink-0 items-center justify-center border shadow-xs {sizes[
		size
	]} {className}"
	style="background: linear-gradient(140deg, color-mix(in oklch, oklch(0.7 0.14 {hue}) 22%, var(--card)), color-mix(in oklch, oklch(0.6 0.16 {(hue +
		40) %
		360}) 8%, var(--card))); color: color-mix(in oklch, oklch(0.55 0.17 {hue}) 85%, var(--foreground));"
	aria-hidden="true"
>
	<Icon strokeWidth={1.75} />
</div>

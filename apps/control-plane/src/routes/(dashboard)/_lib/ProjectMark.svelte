<script lang="ts">
	import * as Avatar from '#lib/components/ui/avatar/index.js';

	/** Project monogram with a stable hue per slug, readable in both themes. */
	let { slug, name, size = 'md' }: { slug: string; name: string; size?: 'md' | 'lg' } = $props();

	const hue = $derived.by(() => {
		let hash = 0;
		for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) % 360;
		return hash;
	});
</script>

<Avatar.Root class="rounded-lg after:rounded-lg {size === 'lg' ? 'size-12' : 'size-9'}">
	<Avatar.Fallback
		class="rounded-lg font-semibold uppercase {size === 'lg' ? 'text-lg' : 'text-sm'}"
		style="background: color-mix(in oklch, oklch(0.65 0.15 {hue}) 15%, var(--card)); color: color-mix(in oklch, oklch(0.6 0.16 {hue}) 80%, var(--foreground));"
		>{name.trim().slice(0, 1) || slug.slice(0, 1)}</Avatar.Fallback
	>
</Avatar.Root>

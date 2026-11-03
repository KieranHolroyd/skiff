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
		class="rounded-lg font-mono font-semibold uppercase {size === 'lg' ? 'text-lg' : 'text-sm'}"
		style="background: oklch(0.72 0.12 {hue} / 0.16); color: oklch(0.58 0.14 {hue});"
		>{name.trim().slice(0, 1) || slug.slice(0, 1)}</Avatar.Fallback
	>
</Avatar.Root>

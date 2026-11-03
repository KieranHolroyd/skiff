<script lang="ts">
	/** A monogram tile with a stable hue per project, readable in light and dark themes. */
	let {
		slug,
		name,
		size = 'md'
	}: { slug: string; name: string; size?: 'md' | 'lg' } = $props();

	const hue = $derived.by(() => {
		let hash = 0;
		for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) % 360;
		return hash;
	});
</script>

<span
	class="grid shrink-0 place-items-center font-mono font-semibold uppercase ring-1 ring-inset {size === 'lg'
		? 'size-12 rounded-xl text-lg'
		: 'size-9 rounded-lg text-sm'}"
	style="background: oklch(0.72 0.12 {hue} / 0.16); color: oklch(0.58 0.14 {hue}); --tw-ring-color: oklch(0.6 0.12 {hue} / 0.22);"
	aria-hidden="true">{name.trim().slice(0, 1) || slug.slice(0, 1)}</span
>

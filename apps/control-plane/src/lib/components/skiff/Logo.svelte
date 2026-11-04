<script lang="ts">
	let {
		size = 'md',
		wordmark = true,
		class: className = ''
	}: { size?: 'sm' | 'md' | 'lg'; wordmark?: boolean; class?: string } = $props();

	const box = $derived(
		size === 'lg' ? 'size-10 rounded-xl' : size === 'sm' ? 'size-6 rounded-md' : 'size-8 rounded-lg'
	);
	const icon = $derived(size === 'lg' ? 'size-6' : size === 'sm' ? 'size-3.5' : 'size-4');
	const text = $derived(size === 'lg' ? 'text-xl' : 'text-base');
</script>

<span class="inline-flex items-center gap-2 {className}">
	<span class="flex shrink-0 items-center justify-center bg-brand text-brand-foreground {box}">
		<svg viewBox="0 0 24 24" class={icon} aria-hidden="true">
			<g
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="M12 3.5v9" />
				<path d="M12 4.5 6.5 12.5H12" />
			</g>
			<path d="M3.5 15.5h17l-2.6 4.2H6.1Z" fill="currentColor" />
		</svg>
	</span>
	{#if wordmark}
		<span class="font-semibold tracking-tight {text}">Skiff</span>
	{/if}
</span>

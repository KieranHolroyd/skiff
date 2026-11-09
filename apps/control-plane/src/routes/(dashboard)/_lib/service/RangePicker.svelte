<script lang="ts">
	/* Range links come from the server load with `?tab=` re-applied here. */
	/* eslint svelte/no-navigation-without-resolve: ['error', { ignoreLinks: true }] */
	import { Button } from '#lib/components/ui/button/index.js';

	/** Segmented time-range links for a metrics section; keeps the current tab in the URL. */
	let {
		ranges,
		current,
		links,
		tab
	}: {
		ranges: ReadonlyArray<{ key: string; shortLabel: string; label?: string }>;
		current: string;
		links: Record<string, string>;
		tab?: string;
	} = $props();

	function href(key: string): string {
		const url = new URL(links[key] ?? '?', 'http://yoal.local');
		if (tab) url.searchParams.set('tab', tab);
		return `${url.pathname}${url.search}`;
	}
</script>

<div
	class="flex items-center gap-0.5 rounded-lg border bg-muted/30 p-0.5"
	role="group"
	aria-label="Time range"
>
	{#each ranges as option (option.key)}
		<Button
			href={href(option.key)}
			variant={option.key === current ? 'secondary' : 'ghost'}
			size="sm"
			class="h-7 px-2.5 text-xs"
			aria-current={option.key === current ? 'true' : undefined}
			data-sveltekit-noscroll
		>
			{option.shortLabel}
		</Button>
	{/each}
</div>

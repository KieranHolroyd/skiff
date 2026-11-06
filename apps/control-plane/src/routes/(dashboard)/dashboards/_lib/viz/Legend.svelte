<script lang="ts">
	/**
	 * Series legend. Click isolates a series (click again to show all); Ctrl/Cmd-click toggles one
	 * series on or off, like Grafana.
	 */
	let {
		items,
		hidden,
		placement,
		ontoggle
	}: {
		items: Array<{ name: string; color: string; value?: string }>;
		hidden: Set<string>;
		placement: 'bottom' | 'right';
		ontoggle: (name: string, additive: boolean) => void;
	} = $props();
</script>

<ul
	class="flex gap-x-3 gap-y-0.5 text-xs text-muted-foreground {placement === 'right'
		? 'max-w-[45%] min-w-40 flex-col overflow-y-auto'
		: 'max-h-14 flex-wrap overflow-y-auto pt-1'}"
	aria-label="Legend"
>
	{#each items as item (item.name)}
		{@const off = hidden.has(item.name)}
		<li class="min-w-0">
			<button
				type="button"
				class="flex max-w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none {off
					? 'opacity-45'
					: ''}"
				aria-pressed={!off}
				title="Click to show only this series; Ctrl/Cmd-click to toggle it"
				onclick={(event) => ontoggle(item.name, event.metaKey || event.ctrlKey)}
			>
				<span class="h-0.5 w-3 shrink-0 rounded-full" style:background={item.color}></span>
				<span class="truncate">{item.name}</span>
				{#if item.value}<span class="ml-auto pl-2 font-mono text-foreground tabular-nums"
						>{item.value}</span
					>{/if}
			</button>
		</li>
	{/each}
</ul>

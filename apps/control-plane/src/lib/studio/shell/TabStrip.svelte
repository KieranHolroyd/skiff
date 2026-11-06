<script lang="ts">
	import { tick } from 'svelte';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import TableIcon from '@lucide/svelte/icons/table';
	import XIcon from '@lucide/svelte/icons/x';
	import { tabDomId, type StudioTab } from './tabs.js';

	/**
	 * The studio's tab strip (plan 22). Tabs follow the WAI-ARIA tabs pattern (arrows move,
	 * Home/End jump); the close button sits beside each tab and middle-click closes too.
	 */
	let {
		tabs,
		active,
		panelId,
		onselect,
		onclose
	}: {
		tabs: StudioTab[];
		active: string | null;
		/** DOM id of a tab's panel. */
		panelId: (id: string) => string;
		onselect: (id: string) => void;
		onclose: (id: string) => void;
	} = $props();

	let strip = $state<HTMLDivElement | null>(null);

	function label(tab: StudioTab): string {
		return tab.type === 'object' ? tab.node.name : tab.title;
	}

	async function move(index: number) {
		const tab = tabs[(index + tabs.length) % tabs.length];
		if (!tab) return;
		onselect(tab.id);
		await tick();
		strip?.querySelector<HTMLElement>(`#${CSS.escape(tabDomId(tab.id))}`)?.focus();
	}

	function keydown(event: KeyboardEvent, index: number, tab: StudioTab) {
		if (event.key === 'ArrowRight') {
			event.preventDefault();
			void move(index + 1);
		} else if (event.key === 'ArrowLeft') {
			event.preventDefault();
			void move(index - 1);
		} else if (event.key === 'Home') {
			event.preventDefault();
			void move(0);
		} else if (event.key === 'End') {
			event.preventDefault();
			void move(tabs.length - 1);
		} else if (event.key === 'Delete') {
			event.preventDefault();
			onclose(tab.id);
		}
	}
</script>

<div
	bind:this={strip}
	class="flex min-h-9 items-end gap-px overflow-x-auto border-b bg-muted/40 px-1 pt-1"
	role="tablist"
	aria-label="Open objects and queries"
>
	{#each tabs as tab, index (tab.id)}
		{@const selected = tab.id === active}
		<div
			class="group flex max-w-56 shrink-0 items-center rounded-t-md border border-b-0 text-xs {selected
				? 'border-border bg-card text-foreground'
				: 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground'}"
		>
			<button
				type="button"
				id={tabDomId(tab.id)}
				role="tab"
				aria-selected={selected}
				aria-controls={panelId(tab.id)}
				tabindex={selected ? 0 : -1}
				title={tab.type === 'object' ? tab.node.path.join('.') : tab.title}
				class="flex min-w-0 items-center gap-1.5 rounded-tl-md py-1.5 pr-1 pl-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
				onclick={() => onselect(tab.id)}
				onauxclick={(event) => {
					if (event.button === 1) {
						event.preventDefault();
						onclose(tab.id);
					}
				}}
				onmousedown={(event) => {
					// Stop the middle-button autoscroll cursor.
					if (event.button === 1) event.preventDefault();
				}}
				onkeydown={(event) => keydown(event, index, tab)}
			>
				{#if tab.type === 'object'}
					<TableIcon class="size-3.5 shrink-0" />
				{:else}
					<SquareTerminalIcon class="size-3.5 shrink-0" />
				{/if}
				<span class="truncate">{label(tab)}</span>
			</button>
			<button
				type="button"
				tabindex={selected ? 0 : -1}
				aria-label="Close {label(tab)}"
				class="mr-1 rounded p-0.5 opacity-60 outline-none group-hover:opacity-100 hover:bg-background focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring {selected
					? 'opacity-100'
					: ''}"
				onclick={() => onclose(tab.id)}
			>
				<XIcon class="size-3" />
			</button>
		</div>
	{/each}
</div>
